# EPIC-06 — результаты

E06-01…05 реализованы: summary, безопасные экспорты, seek/indexes для 100k findings,
консервативный diff двух сканов. PRD/ТЗ/backlog не переписаны. Несовпадение назначения
`summary.json` описано до реализации и решено в ADR-014; сохраняется discovery1.0,
добавляется `report-summary.json` и immutable bundle. ADR-015 описывает память/diff.
EPIC-07 не начат; AC-28 UI часть остаётся EPIC-08.

## Реализовано

- Summary с bySeverity/byRule/byConfidence, verdict counters, полнотой, ошибками,
  duration. ID/fingerprint EPIC-05 сохранён, scanId не входит в идентичность находки.
- Streaming CSV UTF-8/BOM option/RFC4180, защита формул и control prefixes.
  Self-contained HTML без JS/CDN/активных URL, escaping всех значений, CSP.
- Offset/length indexes по фильтрам и disk hash-trie ID index с bounded leaf sort.
  Page1…200, forward/reverse cursors, фильтры AND и ограниченный budget поиска.
- Diff new/persisting/resolved/unknown через streaming merge. Incomplete, robots
  exclusions, смена scope/policy/engine/rule semantics не дают ложного resolved.
  Отсутствие прежнего needs_review требует человеческой проверки.
- Публикация через immutable generation и атомарный pointer; committed WAL snapshot,
  проверка manifest/checkpoint identity/checksum. Root aliases — удобство, не snapshot API.
- Worker exports; `report_generation_failed` → incomplete, resume без повторных GET.
  CLI build/page/find/compare/diff-page; writer project flock, читаемые legacy1.0
  discovery scans не превращаются в SEO-отчёты задним числом.

## Новые файлы этого этапа

| Файлы | Назначение |
| --- | --- |
| `packages/contracts/src/reports.ts` | Report/context/summary/index/page/diff schemas, ports |
| `packages/reports/src/build.ts` | Streaming summary + CSV/HTML orchestration |
| `packages/reports/src/diff.ts` | Conservative streaming comparison |
| `packages/reports/src/format.ts` | HTML escaping, CSV formula protection, self-contained layout |
| `packages/storage/src/report-files.ts` | Bounded buffered files, report generations, seek/trie reader/writer |
| `packages/storage/src/diff-files.ts` | Durable comparison generation + status paging |
| `apps/worker/src/reporting.ts` | Composition, scope/policy hashes, offline rebuild/compare |
| `apps/worker/src/report.ts` | Operator CLI |
| `tests/report-fixture.ts` | Shared typed synthetic findings/context |
| `tests/reports.test.ts` | Escaping, counters, indexes, paging, corrupt pointers, atomic failure, skewed hashes |
| `tests/report-diff.test.ts` | Positive diff, incomplete/robots/compatibility/history gates |
| `tests/report-integration.test.ts` | Worker/checkpoint/recovery/CLI/legacy/lock checks |
| `tests/report-memory.test.ts` | Separate bounded-heap 100k child |
| `tests/fixtures/reports/benchmark.mjs` | Streaming 100k JSONL/CSV/HTML/seek/filter/ID/diff workload |
| `scripts/smoke-reports.mjs` | Synthetic production-container smoke: reports/page/rebuild/diff |
| `docs/reports.md` | Files, contracts, commands, completeness, retention and limits |
| `docs/EPIC-06-RESULTS.md` | This report |

Изменены для подключения: `packages/{contracts,reports,storage}/src/index.ts`,
`packages/storage/src/durable-discovery.ts` (committedFindings/checkpoint identity),
`apps/worker/src/jobs.ts`, `apps/worker/package.json`, `apps/worker/tsconfig.json`,
`package.json`, `package-lock.json`. Обновлены `README.md`, `docs/development.md`,
`docs/DECISIONS.md`, `AGENTS.md`, `.ai-factory/{DESCRIPTION,PLAN}.md`.
Предыдущие незакоммиченные изменения EPIC-05 сохранены.

## Проверки

- `npm ci --ignore-scripts` — успешно, lockfile воспроизводим.
- `npm run check` — lint, typecheck, **361 tests / 18 files passed**, build packages/UI;
  42 новых теста сверх EPIC-05 (319). Включает 100k child с heap cap96 MiB.
- `npm run smoke` — web/worker health200, private API401, graceful shutdown exit0.
- `npm audit --omit=dev --audit-level=high` — 0 runtime vulnerabilities.
- Docker image собран, оба Compose services healthy. Production synthetic smoke:
  reports/page/offline rebuild/diff, replay, nonroot, read-only root, health200/private401;
  raw HTML/cookies не сохраняются, внешние targets не запрашиваются.
- `git diff --check` — успешно; исходные PRD/ТЗ/backlog/coverage не изменены.
- Hashes ранее проверенных AI Factory skills не изменены; внешняя синхронизация не использована.

Отдельный 100k запуск после исправления буферизации: JSONL 53 888 890 bytes,
CSV 31 189 105 bytes, HTML 22 590 131 bytes; heap cap96 MiB, measured heap≈71.6 MiB,
peak RSS≈193.5 MiB, ≈59.2s за генерацию/индексы/проверки и diff100k.
Последняя страница scanned10, ≈2.5ms; 100k unknown, 0 resolved для incomplete after.
Время/память зависят от среды; это report benchmark, не полный 100k crawler benchmark.

Первый memory test обнаружил превышение RSS: устранено удержание pooled Buffer slabs
при хранении множества мелких index chunks. Фиксированные независимые buffers
сохраняют предел памяти и подтверждены повторным workload; лимит теста не увеличен.

## Следующий этап

EPIC-07: login/session/CSRF/throttling, Projects/scans API, защищённые reports/downloads
и finding/diff endpoints поверх готовых readers. Проверять project/scan authorization
на каждой странице/скачивании; cursor не является токеном доступа. Зафиксировать API
сортировку/nullable totals/empty page + nextCursor, не загружать весь JSONL в handler.
После E07 — UI pagination AC-28 в E08 и общий acceptance/security pass.

До этого web/private routes остаются 401, login/UI не заявлены готовыми. Старые
поколения/сравнения занимают место до retention scan; отдельного generation GC нет.
EPIC-05/06 включены в общий Git checkpoint по явному запросу пользователя; commit см. в истории ветки.
