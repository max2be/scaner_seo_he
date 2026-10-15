# EPIC-04 — результаты

Статус: реализован и проверен storage/worker/CLI слой E04-01…05.
Противоречий между PRD и ТЗ перед реализацией не найдено; решения — ADR-010/011.
Исходные PRD/ТЗ/backlog/examples не изменялись. CMS-зависимостей, БД, Redis и внешних
сервисов не добавлено. EPIC-05 не начат.

## Результат

- File-only WAL, atomic JSON/checkpoint, JSONL, версия/целостность/счётчики на чтении.
- Durable URL/source queues с seek offsets, курсор/snapshot Entity Feed, disk-backed dedupe.
- Транзакция URL включает результат, найденные ссылки и provenance. Незавершённая единица
  откатывается при replay, подтверждённые страницы сохраняются без повторного GET.
- queued/running/completed/incomplete/failed/interrupted/canceled; очередь worker после
  рестарта, SIGTERM shutdown, явный resume после interrupted, runtime cancel message.
- Project flock и общий межпроцессный pool; idempotency по scan ID, duplicate conflict409.
- Retention с экспортом/fsync до удаления, pinned/active protection и cleanup staging.
- Linux production Docker image с flock; nonroot/read-only root/shared private data.

## Созданные файлы

- `packages/contracts/src/durable.ts` — RecoveryState, Checkpoint, DurableEvent, SitemapTask и port.
- `packages/storage/src/atomic.ts` — atomic JSON, sync и JSONL append.
- `packages/storage/src/durable-discovery.ts` — WAL/checkpoint, восстановление и materialized files.
- `packages/storage/src/locks.ts` — flock guardian, lifetime и conflict409.
- `packages/storage/src/scans.ts` — project/scan layout, lifecycle, pool, retention/cleanup.
- `apps/worker/src/jobs.ts` — исполнение, recovery, очередь и cancellation.
- `apps/worker/src/scan.ts` — CLI start/enqueue/work/status/cancel/resume/retention.
- `tests/durable-storage.test.ts` — 17 storage/locking/lifecycle/retention проверок.
- `tests/durable-flow.test.ts` — 11 integration/fault-injection проверок.
- `tests/fixtures/durable/worker.mjs` — отдельный тестовый worker с локальным transport adapter.
- `docs/durable-storage.md`, `docs/EPIC-04-RESULTS.md` — контракт, команды, гарантии и результаты.

## Изменённые файлы

- `packages/contracts/src/index.ts`, `packages/storage/src/index.ts` — публичные exports.
- `packages/storage/src/discovery.ts` — создание materialized spool по заданному пути и offsets.
- `packages/sources/src/discovery.ts` — необязательный recovery port, checkpoints, source tasks,
  автоматическое сохранение результатов durable-проверки, abort до фиксации запроса.
- `packages/sources/src/feed.ts` — продолжение от сохранённого cursor/snapshot, commit по странице.
- `apps/worker/src/main.ts` — bounded worker queue и graceful shutdown.
- `package.json` — `npm run scan`; новых зависимостей нет.
- `deploy/Dockerfile`, `deploy/compose.yaml`, `deploy/.env.example` — flock requirement/concurrency.
- `README.md`, `AGENTS.md`, `docs/DECISIONS.md`, `docs/development.md`, `docs/discovery.md`.
- `.ai-factory/DESCRIPTION.md`, `.ai-factory/PLAN.md`, `.ai-factory/skill-context/aif-plan/SKILL.md`.

До фиксации EPIC-01…04 большая часть проекта оставалась untracked; этот список
выделяет именно EPIC-04. В ходе разработки существующие файлы сохранены, commit/push/PR
автоматически не создавались. Фиксация и отправка выполняются отдельным заданием пользователя.

## Проверки

| Проверка | Результат |
|---|---|
| `npm ci --ignore-scripts` | успешно, lockfile сохранён |
| `npm run check` | lint, TypeScript, **220/220 тестов**, build успешны |
| Регрессия EPIC-01…03 | прежние 192 теста прошли |
| Новые fault/storage/integration tests | 28 прошли, без skipped |
| SIGKILL/SIGTERM отдельного worker | progress сохранён, stale running → interrupted, resume завершает оставшуюся очередь |
| Незавершённая запись/частичный WAL tail | откат до checkpoint, нет дубликатов подтверждённых результатов |
| Повреждённые checkpoint/version/state/cursor/WAL | fail-closed, сеть не вызывается, журнал сохраняется |
| Feed cursor/snapshot и sitemap tasks | завершённые единицы не загружаются заново; snapshot changed → incomplete |
| Дубликат, killed lock owner, global pool | конфликт409, безопасное освобождение, единый concurrency limit |
| Cancel активного GET, maxUrls | явный canceled/incomplete, прерванный запрос не засчитывается |
| Retention failure/restart | несовпавший архив сохраняет оригинал; совпавший позволяет завершить cleanup |
| `npm run smoke` | web+worker health200, private401, graceful exit0 |
| Docker production build + Compose | успешны, оба сервиса healthy |
| Production container CLI/flock smoke | nonroot, writable volume, enqueue/work/resume, duplicate409, killed guardian lifetime проверены |
| `npm audit --omit=dev` | 0 известных runtime vulnerabilities |
| SHA256 проверенных AI Factory skills | vendor файлы не изменены |
| `git diff --check` | успешно |

В облачной среде при Docker build закончился диск; очищены только воспроизводимые
Docker build/npm caches. После очистки было свободно около 18 ГБ, финальная сборка
успешна. Данные volumes и исходники сохранены; сервисы пересозданы из финального образа.

## Acceptance и границы

- AC-23: реальный kill/restart тест доказал восстановление подтверждённого прогресса;
  преждевременный completed не появляется.
- AC-24: storage/worker/CLI отклоняет дубликат с conflict409; locks освобождаются после
  смерти владельца. HTTP endpoint будет в EPIC-07.
- AC-07: maxUrls сохраняет incomplete/truncated/coverage в manifest/summary.
  UI-индикация будет в EPIC-08.

HTTP GET имеет at-least-once семантику: один незакоммиченный sitemap/feed page/URL
может повториться целиком. HTML body не сохраняется. Восстановление — потоковый replay
всего подтверждённого WAL; 100k URL benchmark остаётся EPIC-06/10. Только локальный
Linux volume, без NFS/SMB/multi-host; аппаратные сбои и ENOSPC на каждом syscall не
эмулировались. Auth/UI/SEO rules/reports/cron не входят в этот этап. Production цели,
arm64 и удалённый CI не проверялись.

Новые schemas additive v1.0, старые форматы не изменены. Старые EPIC-03 ephemeral spools
не имеют исходного checkpoint и не мигрируются автоматически; создавайте новый scan.
Exhausted incomplete при resume сохраняет ошибки/лимиты; для повторного наблюдения
или нового конфига нужен новый scan ID.

## Следующий этап

EPIC-05: HTML facts/parser и Rule Engine с положительными/отрицательными fixtures,
устойчивыми finding IDs и сохранением findings в рамках той же транзакции URL.
Сначала HTTP/expected entity/soft404 confidence, затем canonical/robots/sitemap,
links, structured data и метатеги. Ошибки источников не превращать в SEO404/P0;
полноту фида и snapshot учитывать в правилах missing/deleted. Переход — по заданию пользователя.
