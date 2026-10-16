# EPIC-03 — результат

## Реализовано

- E03-01: sitemap index/urlset, namespaces/UTF-8, gzip, DTD/entity protection,
  per-file 50k/50MB и явные ошибки/cycles/caps. HTTP→file→SAX, без полного XML в памяти.
- E03-02: Entity Feed v1 cursor pagination, Zod, отдельный backend HTTPS/allowlist,
  env Bearer с origin lock, cursor/entity duplicate и snapshot consistency checks.
- E03-03: source HTML links, first base/final URL resolution, query/slash policy,
  disk-backed BFS/dedupe и append-only provenance/entity refs.
- E03-04: summary flags и incomplete при maxUrls/maxDepth, source failures,
  operational caps, cancellation и empty discovery. Никаких source_error→SEO404/P0.
- E03-05: parser, интеграционные HTTP/TLS, файловые и CLI tests.

CLI: `npm run discover -- --project /path/to/project.json --output /path/to/private-dir`.
Команды и политика подробно описаны в [discovery.md](discovery.md).

## Приёмка

| AC | Доказательство | Результат |
|---|---|---|
| AC-05 | Index + 2 child maps (включая gzip), сохранение sitemap provenance | pass |
| AC-06 | Sitemap + 2 feed pages + HTML BFS: 7 уникальных URL, без повторного fetch, источники объединены | pass |
| AC-07 | maxUrls/maxDepth/источниковые caps → incomplete/truncated, причина в issues; обработаны уже допущенные URL | pass для CLI/engine; UI относится к EPIC-08 |
| AC-08 | Все cursor pages; 401/timeout/schema/JSON/cursor loop/snapshot change → source_error, независимый crawl продолжается | pass |

Нормативный контракт ТЗ cursor/nextCursor, не выдуманный page API. Термин entityId в PRD
уже согласован как id в v1; новых блокирующих противоречий не найдено. Defaults nofollow,
query exclusions, depth/source caps и ограничения HTTP явно описаны в ADR-008/009.

## Проверено

- `npm ci --ignore-scripts` — pass по обновлённому lockfile.
- `npm run check` — lint/typecheck/tests/build pass.
- **192 tests passed, 8 test files, 0 failed/skipped**: 60 новых + 132 регрессии.
- Parser test: 60k entries в двух картах разрешены, 50001 в одной отклоняется;
  это проверка per-file лимита, не нагрузочный benchmark storage/UI на 100k.
- Реальный HTTP/TLS на локальных fixtures; auth проверен синтетическим токеном,
  редирект на другой origin (даже другой порт того же host) заблокирован без утечки.
- Stream file/hash/multi-chunk/backpressure, timeout cleanup, сохранение старых output
  файлов, CLI exit2/incomplete и exit1/invalid config без echo secret — pass.
- `npm audit --omit=dev` — 0 известных уязвимостей на момент проверки.
- `git diff --check` — pass. Исходные PRD/ТЗ/backlog/coverage/examples не изменены.

Docker production verification: pass. Image собран с TLS/checksum verification;
оба compose сервиса healthy. Production CLI проверен на exit2/summary persistence,
SAX parser imports, writable /data и non-root. Проверка не выполняла сетевых запросов.
`npm run smoke` также pass: health200/private401/graceful shutdown.
Инструкции запуска обновлены в сохранённом черновике среды, публикация не выполнялась.

## Исправления по результатам тестов

HTTP abort мог вернуть результат раньше очистки partial sink. Transport теперь завершает
abort/close прежде, чем возвращает canceled/timeout. Поздний DNS по-прежнему не открывает
соединение. Ошибки storage callback не маскируются под malformed XML; они остаются
операционными ошибками. Состояние sitemapComplete не остаётся true при отмене в середине карты.

## Созданы

- `packages/contracts/src/discovery.ts`
- `packages/sources/src/errors.ts`
- `packages/sources/src/normalization.ts`
- `packages/sources/src/sitemap.ts`
- `packages/sources/src/html.ts`
- `packages/sources/src/feed.ts`
- `packages/sources/src/discovery.ts`
- `packages/storage/src/discovery.ts`
- `packages/storage/src/response-spool.ts`
- `apps/worker/src/discover.ts`
- `tests/discovery-parser.test.ts`
- `tests/discovery-flow.test.ts`
- `tests/discovery-storage-cli.test.ts`
- `docs/discovery.md`
- `docs/EPIC-03-RESULTS.md`

## Обновлены

- `packages/contracts/src/index.ts`, `packages/core/src/index.ts`,
  `packages/sources/src/index.ts`, `packages/storage/src/index.ts` — публичные exports.
- `packages/core/src/http/client.ts`, `packages/core/src/http/transport.ts` — generic stream
  sink и backend scope, прежняя SSRF/TLS/rate/robots защита сохранена.
- `packages/sources/package.json`, `apps/worker/package.json`, `apps/worker/tsconfig.json`,
  `package.json`, `package-lock.json` — parser dependencies, workspace references и CLI.
- `AGENTS.md`, `.ai-factory/PLAN.md`, `.ai-factory/DESCRIPTION.md`,
  `.ai-factory/skill-context/aif-plan/SKILL.md`, `docs/DECISIONS.md`, `docs/development.md`,
  `README.md` — scope, решения и инструкции.
- Saved environment start instructions — возможности и ограничения текущей стадии.

## Границы

- Только изолированные fixtures; production сайт/реальный backend не запрашивались.
- Старые v1 persisted formats не изменены; новые spool/result schemas additive.
- Нет межпроцессного lock, durable checkpoint/resume/leases, retention или восстановления
  после kill. JSON/JSONL артефакт на диске не является доказательством crash durability.
- Pipeline sequential и memory-bounded, но inode/I/O/performance 100k URLs ещё не измерены.
- UI остаётся skeleton, без постановки scan; SEO rules/reports/login — следующие EPIC.
- Outbound network через обязательный proxy здесь не проверялся; pinning не отключается.
- Remote GitHub Actions и arm64 не запускались.

## Следующий этап — EPIC-04

Ввести scan manifest lifecycle и durable single-writer journal/checkpoint, per-project locks,
leases и идемпотентное resume; сохранить source cursor + snapshot contract, не потерять
provenance. Fault-injection kill/restart/corrupted checkpoint и duplicate start 409 должны
доказать AC-23/24 до подключения UI/расписания. Не объявлять завершённым усечённый запуск.
