# EPIC-07 — результаты

E07-01…04 реализованы. Источники: backlog M6, техническое ТЗ §10/11,
AC-02/03 (API часть)/24/26. EPIC-08 не начат.

До реализации описана неоднозначность GET compare: он не может создавать diff,
поскольку GET обязан быть read-only. ADR-016 добавляет POST queue + GET ready result.
Проверка источников и resume — durable worker commands. ADR-017 фиксирует operator
credential-origin bindings и additive storage; исходные PRD/ТЗ/backlog не изменены.

## Возможности

- Реальный async Argon2id PHC из Node24, bounded cost и до2 одновременных KDF.
- Single-admin sessions на диске, абсолютный TTL8h, rotation/logout/config revocation,
  максимум32 сессии, raw bearer cookie не хранится в session file и не возвращается JSON.
- Secure/HttpOnly/SameSite=Strict __Host-cookie, Origin для login, Origin+CSRF для writes,
  no CORS, no-store/CSP/nosniff/referrer/framing headers. Анонимные скачивания401.
- Persistent peer/global login throttling, Retry-After, XFF не доверяется. Значения
  паролей/токенов/headers/target bodies, stack и filesystem paths не попадают в ответы/логи.
- Backend bearer references требуют operator mapping ENV_NAME→HTTPS origins;
  произвольный process.env не может быть отправлен через API в выбранный endpoint.
  Самих backend credentials web не получает; SafeHttpClient worker сохраняет SSRF gate.
- Projects create/read/top-level patch/archive/restore; optional If-Match revision,
  immutable scan snapshots, archive без удаления истории. Partial archive/config mutation
  запрещена. Orphan directories после оборванного create не ломают project list.
- Start/stop/progress/history/resume; idempotency scanId и currentScanId при409,
  shared project flock + global worker pool для всех типов задач, fail-stop при потере
  guardian. Новый cancel после submit resume не очищается при pickup.
- Асинхронная worker source validation: schema400 с безопасными field paths/codes,
  ≤20 sitemap samples + robots + backend, явные sampled/configuredSources; source
  недоступность не становится SEO404/P0. Операции recoverable, сохраняются последние50.
- Findings page/filter/details/summary, streaming JSON/JSONL/CSV/HTML/manifest/errors
  attachments с whitelist и проверкой project/scan, IDs и child links.
- Compare POST/GET, conservative unknown, read-only GET, stale generation409.
- Авторизованный OpenAPI3.0.3 из Zod DTO и document endpoints; schema/refinements
  валидируются runtime. Root пока404 после login: SPA — следующий EPIC.

## Новые файлы

| Файлы | Назначение |
| --- | --- |
| `packages/contracts/src/api.ts` | Auth/session/project/operation/progress/query/download/error schemas |
| `packages/storage/src/auth.ts` | File sessions, bounded persistent rate state |
| `packages/storage/src/projects.ts` | Backward-compatible current config/archive/revisions |
| `packages/storage/src/operations.ts` | Durable request/result queue + bounded operation history |
| `packages/storage/src/safe-files.ts` | Bounded JSON reads, safe paths and no child symlinks |
| `apps/web/src/auth.ts` | Cookie/session/Origin/CSRF/login/logout |
| `apps/web/src/password-hash.ts` | Argon2id PHC generation/validation/verification |
| `apps/web/src/password.ts` | Stdin-only local hash CLI |
| `apps/web/src/credentials.ts` | Operator backend reference/origin policy |
| `apps/web/src/input.ts` | Safe request validation diagnostics; storage corruption stays500 |
| `apps/web/src/routes.ts` | Private REST/control/report/download endpoints |
| `apps/web/src/openapi.ts` | OpenAPI3 schema generation and security metadata |
| `apps/worker/src/operations.ts` | Resume/preflight/diff execution, recovery and shared capacity |
| `scripts/smoke-api.mjs` | Disposable real-socket auth/API/worker/export smoke, no production targets |
| `tests/api-fixture.ts` | Synthetic credentials/config/client lifecycle |
| `tests/api-auth.test.ts` | Argon2/session/rate/Origin/CSRF/privacy/TTL/rotation |
| `tests/api-projects.test.ts` | CRUD/archive/revision/snapshots/locks/input validation |
| `tests/api-operations.test.ts` | Queued worker effects, cancel/resume/restart/sampling |
| `tests/api-reports.test.ts` | Authorized paging/evidence/exports/diff/OpenAPI/traversal |
| `tests/api-security.test.ts` | Credential boundaries, concurrency/global rate, corruption/links/pool/history |
| `tests/api-process.test.ts` | Built real-HTTP process, private startup errors and stdin hash CLI |
| `docs/api-auth.md` | Operator setup, endpoint contracts and explicit limitations |
| `docs/EPIC-07-RESULTS.md` | This report |

Изменены: `apps/web/src/{app,main}.ts`, web package/tsconfig, worker jobs,
`packages/storage/src/{scans,report-files,diff-files,index}.ts`, contracts index,
root package/lockfile, Compose web env wiring, README/development/DECISIONS,
AGENTS и локальные AI Factory scope/plan/architecture metadata.
Новая runtime зависимость только `zod-to-json-schema@3.25.1`; native addon не добавлен.

## Проверки

- `npm ci --ignore-scripts` — успешно, integrity/TLS проверки сохранены.
- `npm run check` — lint/typecheck, **412 tests / 24 files passed**, packages/UI build.
  Новых тестов EPIC-07:51, базовый набор EPIC-01…06:361, без пропусков.
- Сохранён прежний 100k benchmark с V8 heap cap96 MiB: peak RSS≈182.8 MiB,
  measured heap≈67.0 MiB, 108.7s в общем прогоне при параллельных проверках/сборке;
  seek последних10 записей≈2.7ms/scanned10; 100k unknown, 0 false-resolved.
  Это report/index/diff нагрузка, не full crawler benchmark.
- `npm run smoke` — web/worker health200/private401, graceful exit0.
- Real-socket API smoke и production Docker synthetic smoke: Argon2id, secure cookie,
  CSRF, project create, duplicate409, durable worker resume, private exports, OpenAPI,
  logout revocation; nonroot, без внешних targets. Reports replay/diff smoke также прошёл.
- `npm audit --omit=dev --audit-level=high` — 0 runtime vulnerabilities.
- `git diff --check` — успешно. Исходные PRD/ТЗ/backlog/coverage не изменены;
  hashes ранее проверенных AI Factory vendor skills прежние, внешняя синхронизация не использована.

Синтетические проверки не обращаются к production сайтам. Docker smoke проверяет
настоящий runtime Node crypto, nonroot и shared file adapters; local HTTP client
явно передаёт cookie, это не browser/TLS deployment test. Deployment web без пользовательского
ADMIN_PASSWORD_HASH/PUBLIC_ORIGIN продолжает health200/private401/login503.
Пользовательский пароль не генерировался и не запрашивался в чате.

Сохранён черновик cloud setup: install_script, start_skill и имена прямых app env
ADMIN_PASSWORD_HASH/PUBLIC_ORIGIN/BACKEND_CREDENTIAL_ORIGINS без секретных значений.
Сохранение не применяет конфигурацию и не публикует среду; Review/Save и Publish —
отдельные действия пользователя в настройках среды. Репозитории/network memberships
не менялись; успешный GitHub API доступ этим не заявляется.

## Границы и следующий этап

AC-02/24/26 покрыты на API/worker; AC-03 API validation/save покрыты, форма UI — E08.
Нет RBAC/SSO/public SaaS, полного browser SPA, cron/TLS proxy deployment и новых SEO rules.
Node24 встроенный Argon2 API experimental; смена Node требует повторной проверки.
За proxy rate buckets общие (trustProxy=false); это безопасный single-admin default.
File volume доверенный, Unix UID общий для приложения, NFS/multi-host не поддержаны.

Для доступа оператор задаёт PHC hash и точный HTTPS PUBLIC_ORIGIN; backend credentials
настраиваются отдельно только worker и связываются с origins. Готовых default credentials нет.
EPIC-08: login/session timeout, projects forms, queue/progress/incomplete state,
findings/evidence/downloads/diff UI поверх готовых DTO. Обязательно соблюдать nullable totals,
empty page+cursor и202 operation polling; не запускать crawler из frontend/API.
После E08 — E09 эксплуатационный TLS/security/acceptance pass.

При последующем объединении веток EPIC-07 сохранён коммитом `cbadfc3` в `sum1-7`.
Результаты объединения и повторной проверки: [SUM1-7-RESULTS.md](SUM1-7-RESULTS.md).
