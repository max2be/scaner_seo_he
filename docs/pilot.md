# Воспроизводимая демонстрация и подготовка пилота

EPIC-10 использует только локальные синтетические данные. Ниже нет разрешения
на сканирование чужих доменов и нет зависимости от внешних CMS/API.

## Подготовка и demo

Node24.19.0/npm11, Linux с `/usr/bin/flock`; `npm ci --ignore-scripts && npm run build`.
Запуск из корня репозитория:

```bash
npm run demo
# При необходимости сохранить synthetic DATA_DIR и отчёты в НОВЫЙ каталог:
npm run demo -- --output /tmp/hsi-demo-review-01
```

Default очищает временные данные после проверок; output каталог должен отсутствовать.
При ошибке retained output остаётся для локальной диагностики и не объявляется успешным
snapshot. Запускаются loopback HTTP/TLS servers со свободными портами, logical URLs
`shop.example.com`/`content.example.org` отображаются только fixture transport.
Реальный DNS/сеть этих доменов не используются. Runtime приложение не получает
флага allow-private, TLS bypass или иной обход SSRF. Сертификат — публичная test fixture,
доверенная только внутри demo; credentials синтетические.

Интегрированный shop: sitemap index + XML/gzip, cursor Entity Feed, published/deleted,
HTTP404 confirmation, canonical, broken link, rating, buttons/shell/redirects.
Standalone content: независимый профиль и HTML links без backend. Восемь scans включают
повтор, release-run, robots, malformed XML, maxUrls и redirect loop. После завершения stdout
содержит JSON checks/counts, а retained output — `acceptance.json` и приватный `data/`.
После demo fixture servers останавливаются. Retained DATA_DIR содержит историю и HTML/CSV
для просмотра; новый scan этих logical URLs требует нового CLI demo, а не обращения к
публичному example hostname. Для просмотра истории в собственной панели укажите retained
`data/` как DATA_DIR с отдельной admin/HTTPS конфигурацией по deployment runbook.
Ничего не отправляется во внешние сервисы и существующие operator volumes не открываются.

## Нагрузочное исследование10k/100k

```bash
npm run benchmark:pipeline
# Только10k или только100k:
npm run benchmark:pipeline -- --sizes 10000
npm run benchmark:pipeline -- --sizes 100000
# Сохранить metrics в НОВЫЙ файл; parent directory подготовить заранее:
npm run benchmark:pipeline -- --output /tmp/hsi-pipeline-metrics-01.json
```

Отдельный child на каждый размер, V8 old-space cap128 MiB, peak RSS budget384 MiB, timeout60min
на размер. По умолчанию размеры идут последовательно. Нужен запас диска/inodes под
файловый journal/derived observations/indexes; перед запуском `df -h` и `df -i`.
Используются временные каталоги; завершённый прогон удаляет только собственные данные.
При SIGKILL временный каталог может остаться — проверяйте принадлежность перед удалением.
Не запускайте на операторском DATA_DIR. Не запускайте рядом несколько100k workloads.

Проверяется реальный worker `runScan`: sitemap discovery, queue/provenance, per-page durable
commit/fsync, HTML parsing, настроенные standalone HTML rules, analysis checkpoints, reports и bounded pagination.
Replay client возвращает заранее заданные HTTP факты: это storage/pipeline benchmark,
а не нагрузочный HTTP клиент. Нет ожидания request-rate и сетевых соединений;
production SafeHttpClient не меняется. Sitemap разбит максимум по50000 URL.
Каждая сотая страница без description создаёт известный объём findings; число обработанных
URL, observations и report rows проверяется точно. Progress `processed` относится к получению страниц: после100000 он остаётся постоянным
во время отдельной analysis/report фазы; окончательный JSON появляется только после её проверки.
В JSON выводятся count/requests/processed (requests — только page fetch replay, без sitemap source reads),
analysis count, pages/totals, heap/RSS, journal/disk bytes, duration и transport label.
Success JSON выдаётся только после последовательной очистки собственного дерева;
`cleanupVerified` и `cleanupSeconds` подтверждают этот этап. Peak RSS включает очистку,
`seconds` измеряет pipeline до очистки, filesystem footprint измеряется до удаления.

100k report/diff benchmark с cap96 MiB остаётся в обычном `check`. Он измеряет другую
часть системы; его результат нельзя подменять результатом полного durable scan.
Для проверки cardinality/памяти на tmpfs можно использовать отдельный режим после сборки
`hsi:0.1.0` (cloud: задайте `DOCKER_CONFIG=/workspace/.docker-hsi`):

```bash
npm run benchmark:pipeline -- --sizes 100000 --storage docker-tmpfs
```

Он создаёт один disposable nonroot container без сети, с read-only root, tmpfs3 GiB и
container memory limit4 GiB. В него read-only монтируются только synthetic fixture scripts
и examples. Операторский DATA_DIR/volumes не используются. `filesystem:docker-tmpfs`
в metrics обязателен; `diskMiB` в таком прогоне означает tmpfs allocated footprint.
Node RSS не включает память файловой системы: её ограничивает отдельный container limit.
Такой результат показывает bounded application heap/cardinality и **не подтверждает**
скорость или durability физического диска. Disk и tmpfs результаты нельзя усреднять.
При обычном `--storage disk` используется локальная FS временного каталога.

GitHub workflow `Generated pipeline load` запускается вручную; он сохраняет только
синтетические metrics, без DATA_DIR/HTML/ENV. Время зависит от fsync/storage.

## Локальная QA и human sign-off

Автоматические доказательства по всем AC: [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md).
Локальная review проверяет границы imported fixtures, отсутствие production bypass,
синтетические credentials, no-overwrite output и cleanup; результаты — в EPIC-10 report.
Chromium проверяет desktop/mobile390px, labels/keyboard, private routes/expiry,
malicious evidence, streaming downloads, comparison, schedule editor и маршрут
«последний scan → находки → доказательство» за три клика от dashboard.

До производственного пилота оператор отдельно подтверждает:

- HTTPS hostname/certificate renewal, точный PUBLIC_ORIGIN, private admin setup, firewall/egress.
- Offline backup и restore drill в новый каталог; disk/inodes/retention destination.
- Allowlist обоих сайтов, canonical/query policies, source/feed snapshot semantics.
- Read-only feed token только worker, origin binding для web, отсутствие PII в feed/evidence.
- Разрешение владельца на scan, окно запуска, maxUrls, rate/concurrency, контакт для остановки.
- Оценку выборки expected/finding/needs_review вместе с владельцем бизнес-данных.

Это checklist готовности для владельца, а не автоматически проставленный human sign-off.
Ограничения/известные вопросы должны быть перенесены в pilot notes с решением владельца.

## Необязательный owner-approved production pilot (E10-05)

Только после согласования используйте [deployment.md](deployment.md). Начните с preflight,
затем ограниченного scan; разумная начальная скорость1 request/s/host, concurrency2,
ограниченные retries/timeouts и явный maxUrls. Большой каталог может потребовать часов:
100000 запросов при1/s — минимум27.8h без учёта дополнительных запросов.
Перед full scan проверьте disk/inodes и ожидаемый объём HTML/index/journal.

Не включайте расписание до проверки первого результата. При429/5xx/circuit/reasons
проверьте diagnostics и остановите задания по согласованному порядку. Incomplete не есть
полный аудит; исчезнувшие находки не объявляются исправленными. Сохраните baseline,
версию профиля/rules и owner-approved выводы. После контролируемого релиза выполните
второй сопоставимый scan и diff; проверьте P0 вручную по подтверждённым фактам.
Отчёт не подтверждает индексацию Google/Яндекс и не исправляет сайт автоматически.

## Обновление rule версии

SSR_CONTENT_MISSING изменён с1.0.0 на1.0.1. Не обновляйте runtime посреди активного анализа.
Ранее опубликованные отчёты остаются читаемыми как immutable snapshots. Rebuild старого
scan с находками прежней версии может отклониться по version mismatch: новый runtime
не переписывает историю под другую семантику. Выполните новый полный scan и сравнение;
изменение rule версии даёт conservative unknown, а не доказанный resolved.
