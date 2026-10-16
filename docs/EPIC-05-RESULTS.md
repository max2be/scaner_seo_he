# EPIC-05 — результаты

Статус: E05-01…07 реализованы, проверены на синтетических fixtures.
Источники: FR-04, ТЗ §7/8, AC-09…18. Новых неразрешённых противоречий PRD/ТЗ
перед реализацией не найдено; решения — ADR-012/013. EPIC-06 не начат.

## Реализовано

- Source HTML parser: head/title/description/H1/a, canonical, scoped meta/X-Robots,
  DOM IDs, manifest, image attributes, button navigation hints, SSR/soft404 hints.
- JSON-LD arrays/@graph/known nested fields, Product/Offer/AggregateRating count checks,
  identity-aware price/currency/availability compare с backend.
- 31 правило версии1.0.0, stable fingerprints, runtime validation результатов,
  confidence/severity gates, изоляция exceptions в analysis errors.
- Safe canonical/slash GET checks через прежний shared SafeHttpClient; отсутствуют
  новые private-IP/TLS bypass настройки. Ни JS, ни внешние contexts не исполняются.
- Facts фиксируются вместе с URL transaction; анализ использует финальную provenance,
  файловые title groups и отдельный checkpoint cursor. Findings сохраняются в JSONL/WAL.
- Optional frozen rules.json/CLI --rules: severity overrides, redirect threshold,
  slash checks, только явно заданные unknown-route probes.
- Storage1.1 для новых scans, reader1.0 и nonempty legacy fixture. Старые scans не
  объявляются SEO-проверенными задним числом; для новых правил нужен новый scan ID.

P0 HTTP404/410 требует published + explicit expectedIndexable + expected200 + complete
consistent feed + двух согласованных GET. Deleted/unpublished/unknown, source failure,
неполный/изменившийся feed не дают такого P0. При complete feed без optional snapshot
наблюдённые entity-расхождения сохраняются как needs_review/P1, не скрываются и не
превращаются в доказанный P0. Мета/JSON-LD quality и JS/SSR hints не повышаются до P0.

## Созданные файлы

- `packages/contracts/src/seo.ts` — facts, profile, observation, analysis progress/errors/summary,
  versioned events и RuleResult schemas.
- `packages/core/src/seo/context.ts`, `engine.ts`, `rules.ts` — контекст, безопасное исполнение,
  31 правило, fingerprint и severity gates.
- `packages/sources/src/page-facts.ts` — bounded HTML/JSON-LD parser, charset, robots scopes,
  allowlisted/redacted evidence.
- `apps/worker/src/analysis.ts` — facts collection, diagnostics и resumable analysis pass.
- `tests/seo-fixture.ts` — общий синтетический context.
- `tests/seo-parser.test.ts` — 27 проверок parser/security/limits/charset.
- `tests/seo-rules.test.ts` — 53 positive/negative проверки правил/confidence/ID/severity/errors.
- `tests/seo-integration.test.ts` — 16 pipeline/network/legacy/recovery/indexability проверок.
- `tests/seo-cli.test.ts` — 3 проверки собранной production CLI/profile validation.
- `tests/fixtures/storage-v1/{README.md,checkpoint.json,journal.jsonl}` — legacy1.0 с
  подтверждённым URL/HTTP200/summary/checksum.
- `docs/seo-rules.md`, `docs/examples/rules.example.json`, `docs/EPIC-05-RESULTS.md`.

## Изменённые файлы

- `packages/contracts/src/index.ts`, `durable.ts` — exports, additive checkpoint/WAL1.1.
- `packages/core/src/index.ts` — совместимое расширение RuleContext и exports.
- `packages/core/src/http/client.ts`, `transport.ts` — transient X-Robots/raw final URL;
  cookies и остальные headers не добавлены в persisted HTTP contracts.
- `packages/sources/src/discovery.ts`, `index.ts` — explicit control seeds, confirmation
  callback, parser exports. Прежний `discover` остаётся discovery-only.
- `packages/storage/src/durable-discovery.ts` — версионируемый replay, facts/findings/errors,
  title buckets, analysis cursor; writer не может подтвердить строку сверх reader limit.
- `packages/storage/src/scans.ts` — frozen profile/idempotency и validation scope.
- `apps/worker/src/jobs.ts`, `scan.ts` — pipeline/--rules/ошибки конфигурации до сети.
- `apps/worker/package.json`, `tsconfig.json`, `package-lock.json` — явная workspace
  зависимость от @hsi/core; новых внешних зависимостей/обновлений версий нет.
- `tests/durable-flow.test.ts` — ожидаемый дополнительный slash GET и deterministic
  regression для stale cancel при медленном resume.
- `README.md`, `AGENTS.md`, `docs/DECISIONS.md`, `docs/development.md`, `docs/discovery.md`,
  `docs/durable-storage.md`, `.ai-factory/{DESCRIPTION.md,PLAN.md,skill-context/aif-plan/SKILL.md}`.

Исходные PRD/ТЗ/backlog/coverage и прежние example project/feed не изменены.
Коммиты/push/PR в рамках EPIC-05 не выполнялись; checkpoint EPIC-01…04 — `235ddec`.

## Проверки

| Проверка | Результат |
|---|---|
| `npm ci --ignore-scripts` | успешно, версии lockfile сохранены |
| `npm run check` | lint, TypeScript, **319/319 тестов**, build успешны |
| Regression EPIC-01…04 | 220 проверок проходят; HTTP SSRF/TLS/robots gate сохранён |
| Новые parser/rules/pipeline/CLI | 99 проверок прошли, skipped/disabled нет |
| Expected404 + source/negative cases | подтверждённый P0; deleted/200/source-failure/unknown snapshot не получают ложный P0 |
| Canonical/slash/query identity | explicit policy, unknown/preserve, безопасные targets, final URL hash проверены |
| Links/provenance | target мог быть проверен раньше sourcePage; broken finding сохраняет источник |
| JSON-LD | count missing/invalid/valid, no rating, parse errors, Product/Offer compare/ambiguity проверены |
| Rule errors/limits | parser/rule/fetch ошибки отдельны от findings; partial facts не создают missing-field pass/findings |
| Resume и migration | analysis cursor, unique finding IDs, WAL replay без GET; legacy1.0 сохраняет URL/result/version |
| `npm run smoke` | web+worker health200/private401/graceful exit0 |
| Docker production build | успешно |
| Docker production pipeline | nonroot, private writable volume, local HTTP→facts→rules→findings1.1→replay, без внешних целей |
| Production health | оба Compose сервиса healthy, /api/health200 |
| `npm audit --omit=dev` | 0 известных runtime vulnerabilities |
| Reviewed AI Factory hashes | vendor файлы не изменены |
| Example rules profile + `git diff --check` | успешно |

В процессе regression воспроизведена и исправлена гонка старого cancel-флага при
медленном получении слота: polling начинается после очистки флага и перехода running.
Fault tests SIGKILL/SIGTERM остаются зелёными. Исходный HTML, cookie, Bearer и произвольные
JSON-LD поля не попадают в WAL; проверяется конкретными fixtures. Business URLs/entity
IDs/SKU/cursors по контракту остаются приватными данными хранилища.

## Acceptance

| AC | Доказательство |
|---|---|
| AC-09 | published/expected-indexable200 + два404 → EXPECTED_PAGE_NOT_200 с entity/status/attempts |
| AC-10 | deleted/404 не создаёт ожидаемую страницу/P0 |
| AC-11 | unknown/preserve не назначают правильный слеш; observed variants сохраняются |
| AC-12 | explicit canonical policy conflict и корректный canonical различаются |
| AC-13/14 | AggregateRating без count → P1; отсутствие самого rating — pass |
| AC-15 | broken internal link имеет sourcePage, включая позднюю provenance |
| AC-16 | button navigation hint — needs_review, не broken link |
| AC-17 | skipped_robots — не404/noindex; только applicable profile directives |
| AC-18 | sparse expected server HTML — needs_review, без утверждения о доказанном soft404/бане |

## Ограничения и следующий этап

Результаты — технические факты наших запросов, не ответ настоящего поискового робота.
JSON-LD checks целевые, не полный schema.org/Google validator. Автоопределение HTML charset
по meta не реализовано; HTTP charset поддерживается через Node TextDecoder, неизвестный
charset/ошибочные байты дают incomplete. Limits явно описаны в seo-rules.md.

Дополнительные canonical/slash GET увеличивают нагрузку; manifest URL counters относятся
к основному discovery, отдельные checks видны в observations. Full100k storage/recovery/UI
benchmark, arm64 и удалённый CI не выполнялись. Production сайты не сканировались.
RuleProfile не расширяет ProjectConfig, не разрешает новые hosts и не хранит токены.

EPIC-06: агрегировать по severity/rule, построить file-only seek/paging indexes, CSV/HTML
escaping, безопасный export и diff stable findings с unknown для incomplete второго scan.
Не объявлять needs_review автоматически исправленным/ошибкой и не терять provenance.
Auth/API/UI и cron остаются отдельными последующими этапами.
