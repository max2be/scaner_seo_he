# Durable storage и lifecycle — EPIC-04

Источник требований: FR-05.2…05.6, ТЗ §9, E04-01…05, AC-07/23/24.
Реализация рассчитана на Node.js 24 и Linux с `/usr/bin/flock`, локальный общий
Docker volume. NFS/SMB, несколько машин и объектные хранилища не поддерживаются.
Проверки используют синтетические локальные HTTP/TLS fixtures; production сайты не сканировались.

## Запуск и управление

После `npm ci --ignore-scripts && npm run build`:

```sh
npm run scan -- --action enqueue --project /private/project.json --data /private/data --scan-id manual-001
npm run scan -- --action status --data /private/data --project-id demo-shop --scan-id manual-001
npm run scan -- --action cancel --data /private/data --project-id demo-shop --scan-id manual-001
npm run scan -- --action resume --data /private/data --project-id demo-shop --scan-id manual-001
npm run scan -- --action retention --data /private/data --project-id demo-shop --keep 10 --export /private/archive
```

`demo-shop` заменяется на `id` из ProjectConfig. `--action start` сразу ставит и исполняет
задание; `enqueue` только сохраняет его. `--action work` обрабатывает сохранённую очередь
однократно. `npm run start:worker` опрашивает очередь каждые 500 мс. Прежний `discover`
остаётся отдельной диагностической командой с ephemeral spool; для resume используйте `scan`.

Все процессы, использующие один `--data`/`DATA_DIR`, обязаны задавать одинаковую
параллельность: CLI `--concurrency 2`, worker `JOB_CONCURRENCY=2` (по умолчанию 2, диапазон 1…8).
Первое значение фиксируется в `pool.json`. Для изменения остановите все процессы,
сделайте backup и измените это значение согласованно; разные значения отклоняются.

Коды CLI: 0 — команда выполнена/completed/queued; 2 — incomplete/interrupted/canceled;
3 — конфликт (семантика HTTP 409); 1 — ошибка/failed. REST endpoints будут в EPIC-07.
Реальное сканирование разрешённого проекта запускает только оператор. Токены читаются
из env по `tokenEnv`, не передаются в CLI и не сохраняются в результатах.

## Файлы и авторитет состояния

```text
DATA_DIR/pool.json
DATA_DIR/locks/pool-config.lock, job-N.lock
DATA_DIR/projects/PROJECT/project.json
DATA_DIR/projects/PROJECT/locks/scan.lock
DATA_DIR/projects/PROJECT/scans/SCAN/
  project.json          неизменяемый конфиг конкретного запуска
  manifest.json         состояние и подтверждённые счётчики
  checkpoint.json       версия, checksum, граница WAL, offsets, phase, feed cursor/snapshot
  journal.jsonl         журнал типизированных операций
  queue.jsonl           фиксированные SHA256 URL keys, seek по offset
  urls.jsonl            результат каждого подтверждённого запроса без HTML body
  scanner_errors.jsonl  ошибки источников/получения, отдельно от SEO findings
  summary.json          итог discovery после финального checkpoint
  derived/              перестраиваемые URL buckets, provenance, markers, source-task queue
  temporary/            только временные XML текущей попытки
  cancel.json           необязательное атомарное управляющее сообщение
  pinned.json           необязательный маркер защиты от retention
```

`queue.jsonl`, `urls.jsonl`, `scanner_errors.jsonl` — hard links на соответствующие
файлы `derived/`, не независимые копии. После восстановления ссылки пересоздаются.
Они могут содержать незакоммиченный хвост работающего/прерванного задания. Для чтения
результатов сначала проверяйте manifest и checkpoint; не делайте вывод о completed по
наличию summary или JSONL файла. API согласованного чтения — следующий соответствующий этап.
`findings`, exports и report indexes появятся в EPIC-05/06.

Новые Checkpoint/RecoveryState/DurableEvent/SitemapTask schemas имеют schemaVersion 1.0;
старые ProjectConfig/ScanManifest/Discovery schemas не менялись. EPIC-03 temporary
spool не имеет checkpoint: автоматической миграции в resumable scan нет. Используйте новый
scan ID; существующие spool не удаляются и не объявляются восстановленными.

## Протокол commit и восстановления

Единица работы: один sitemap, одна страница backend-фида или один URL со всеми
извлечёнными ссылками и provenance. Сначала операции последовательно записываются в WAL
и применяются к перестраиваемым файлам. В commit: fsync журнала, затем атомарная запись
checkpoint (`wx temporary → fsync → rename → fsync parent`). Только после этого обновляется
manifest. Новая директория скана публикуется rename из staging под блокировкой проекта.

Checkpoint хранит число URL, seek offsets обеих очередей, фазу discovery, счётчики,
курсор/счётчики/snapshot фида, SHA256 подтверждённого префикса WAL и checksum самого
checkpoint. Runtime schemas проверяют версии и непротиворечивость счётчиков/offsets.

При resume worker проверяет checkpoint, длину, schemas и hash WAL; удаляет хвост после
последнего commit; потоково перестраивает derived из подтверждённых операций и
восстанавливает offsets. Память не содержит Map/массив всего каталога. Время восстановления
пропорционально размеру журнала и числу файлов; производительность на 100k ещё не измерена.
Checkpoint повреждён/версия неизвестна/журнал повреждён — `failed/storage_corrupt`,
без сети и без автоматического старта с нуля. Исходный журнал сохраняется для диагностики.

Завершённые страницы и страницы фида не запрашиваются повторно. Незакоммиченная единица
может повториться целиком, включая один sitemap; это at-least-once HTTP GET с идемпотентными
результатами на диске, а не обещание exactly-once сетевого запроса. Исходный HTML не
сохраняется. Временный XML прерванной попытки очищается под lock при следующем исполнении.
Последующая страница фида проверяется против сохранённого snapshot; изменение даёт
`feed_snapshot_changed` и incomplete. Отсутствие snapshot остаётся unknown.

## Состояния и блокировки

- queued → running → completed/incomplete/failed/interrupted/canceled.
- SIGTERM/SIGINT: abort активного GET, текущая единица не подтверждается, статус interrupted.
- SIGKILL: manifest может остаться running; следующий worker после успешного lock меняет
  его на interrupted. Продолжение требует явной команды resume.
- queued задания автоматически подхватываются worker после рестарта.
- canceled/interrupted/incomplete допускают resume при отсутствии другого активного скана.
- exhausted incomplete остаётся incomplete: resume не удаляет ошибки и не расширяет maxUrls.
  Для повторной проверки ошибок источников или изменения лимитов создайте новый запуск.
- completed/failed не перезапускаются тем же scan ID. Для исправления повреждения нужен
  разбор backup/журнала оператором или новый scan ID.

Один project lock удерживается на всё исполнение и операции retention. Второй старт
отклоняется с 409; идемпотентный enqueue того же scan ID и того же конфига возвращает
сохранённый manifest. Этот scan ID можно использовать как ключ запуска по расписанию.
Глобальные numbered flock slots ограничивают совокупность CLI и worker процессов.

Lease metadata хранится ядром через lock guardian и pipe lifetime; нет небезопасного
удаления «старого» lock по PID/timeout. При смерти владельца pipe закрывается, guardian
завершается и ядро освобождает lock. При неожиданной потере guardian работающий worker
завершается fail-stop. Lock-файлы никогда не unlink: это предотвращает гонку двух inode.

## Retention, cleanup и backup

Политика запускается явно; автоматическое расписание — EPIC-09. `--keep` оставляет
последние N терминальных сканов, опциональный `--days` также ограничивает возраст.
Running/queued/interrupted и `pinned.json` защищены. Перед удалением выполняются приватная
копия в `.tmp` вне DATA_DIR, fsync дерева, rename и fsync каталога архива. Ошибка архивации
сохраняет оригинал. После сбоя между rename и удалением повторная операция сравнивает
потоковые SHA256 всего дерева; совпавший архив позволяет завершить удаление, отличающийся
блокирует его. Staging незавершённого enqueue очищается только под project lock.

Не удаляйте lock-файлы вручную. Backup делайте после остановки worker/CLI либо под project
lock: копируйте frozen project.json, manifest, checkpoint и WAL вместе. Derived можно
восстановить из WAL. Содержимое DATA_DIR и архивов приватно: URLs, Entity Feed и курсоры
могут быть чувствительными, хотя Bearer/cookies и raw HTML не сохраняются.

## Границы проверки

Fault tests реально завершают отдельный процесс SIGKILL/SIGTERM между двумя GET.
Дополнительно проверяются незакоммиченный хвост/частичная строка, курсоры, snapshot,
порча checkpoint/WAL, конфликт и освобождение lock, общий pool, отмена и retention.
Модель рассчитана на файловую семантику локального Linux volume; сбой оборудования,
полный диск на каждом возможном syscall и 100k benchmark пока не воспроизведены.
UI-индикация AC-07 и HTTP 409 endpoint AC-24 остаются EPIC-07/08; здесь проверен storage/CLI слой.

## EPIC-05 update
Новые scans включают SEO analysis и используют checkpoint/WAL1.1, rules.json, facts,
findings и отдельный analysis cursor. Reader1.0 сохранён. `discoveryComplete` и анализ
отличаются: parser/analysis errors делают scan incomplete без сокрытия завершённого discovery.
Правила и migration: [seo-rules.md](seo-rules.md). Legacy1.0 не реанализируется автоматически.
