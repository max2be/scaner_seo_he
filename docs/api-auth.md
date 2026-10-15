# Авторизация и API — EPIC-07

E07 реализует single-admin API; браузерный интерфейс — отдельный EPIC-08. GET health
публичен и минимален. Без настроенного admin остальные данные закрыты401, login503.
При валидной сессии root пока404: SPA намеренно не публикуется раньше E08.

## Настройка администратора

Node24.19.0 обязателен: используется встроенный async `crypto.argon2('argon2id')`,
без внешнего native addon и install scripts. В Node24 этот API имеет experimental
статус. PHC format: Argon2id v19, memory64…128 MiB, passes2…6, parallelism1…4,
salt16…32 bytes/tag32…64 bytes; helper генерирует m65536,t3,p1,salt16,tag32.

После `npm ci --ignore-scripts && npm run build`, в локальном Bash терминале:

```bash
read -rsp 'Admin password: ' hsi_admin_password
printf '\n'
export ADMIN_PASSWORD_HASH="$(printf '%s' "$hsi_admin_password" | node apps/web/dist/password.js)"
unset hsi_admin_password
export PUBLIC_ORIGIN=https://inspector.example.com
```

Не передавать пароль аргументом командной строки, не коммитить hash/password/env-файл.
Helper читает stdin, требует12…1024 bytes, выводит только PHC hash. Сгенерированный hash
задаётся только web через env/локальную конфигурацию развёртывания. Worker он не нужен.
Оператор выбирает свой пароль; тестовые значения не являются default credentials.

`PUBLIC_ORIGIN` — точный внешний HTTPS origin без trailing slash/path. Любая нелокальная
публикация требует TLS reverse proxy; он должен сохранять Origin и Cookie. Cookie всегда
Secure, поэтому обычная HTTP страница не является рабочим способом browser login.
Готовая reverse-proxy/TLS эксплуатационная конфигурация — E09; localhost preview не нужен.
Сетевой smoke использует явную передачу Cookie клиентом по локальному HTTP, проверяет
флаги/протокол API, но не выдаётся за проверку браузера через production TLS proxy.

Оба auth env отсутствуют/пусты → health работает, данные закрыты. Только один задан,
invalid hash/HTTP origin → startup failed с обезличенным сообщением; insecure fallback нет.
`JOB_CONCURRENCY` web/worker/CLI должен совпадать с сохранённым pool.json.

## Backend secrets

API принимает только `tokenEnv`, никогда значение токена. Web не получает сами backend
токены. Для bearer reference оператор отдельно задаёт web-параметр:

```bash
export BACKEND_CREDENTIAL_ORIGINS='{"ENTITY_FEED_TOKEN":["https://feed.example.com"]}'
```

Секрет `ENTITY_FEED_TOKEN` передаётся только worker через env/docker secret provisioning
конкретной инсталляции; стандартный compose не угадывает список произвольных secret refs.
Mapping содержит только имена и HTTPS origins. Без binding API отклоняет включение bearer
с кодом400 `backend_credential_binding_required`. Изменение endpoint origin требует нового
binding, даже если имя tokenEnv прежнее. Это защищает от запроса произвольного process.env
(например ADMIN_PASSWORD_HASH) через remote API. CLI с конфигом остаётся инструментом
доверенного оператора; не передавать worker лишние секреты окружения.

## Сессия, CSRF и лимиты

- `POST /api/auth/login`: JSON `{ "password": "…" }`, optional username=`admin`;
  обязательный Origin==PUBLIC_ORIGIN. Без него403; no form-urlencoded login.
- Ответ: `{schemaVersion,role,csrfToken,expiresAt}` и cookie `__Host-hsi_session`:
  Secure, HttpOnly, SameSite=Strict, Path=/, без Domain, Max-Age8h.
- `GET /api/me` возвращает текущую роль/CSRF/expiry; cookie bearer raw token не
  возвращается в JSON. На диске только SHA256 cookie ID + CSRF и expiry, mode0600.
- Любой authenticated write требует Cookie, точный Origin и `X-CSRF-Token` из login/me.
  Cross-site fetch отклонён. `GET/HEAD` не выполняют business mutations.
- Повторный login создаёт новый ID/CSRF и отзывает предъявленную прежнюю сессию;
  logout удаляет session file и очищает cookie. Absolute TTL8h, без фонового продления.
  Изменение password hash или origin отзывает все прежние sessions. File sessions
  переживают restart, максимум32; старейшая вытесняется. Cookie не логируется.
- Persistent rate limit:5 login attempts/IP за5min,20 суммарно/min; malformed JSON
  тоже расходует попытку. Дополнительно до2 KDF одновременно, нет неограниченной очереди.
  При429 есть Retry-After. File-lock contention также может вернуть429/retry1s.
- `trustProxy=false`: X-Forwarded-For не меняет identity. За reverse proxy все клиенты
  разделяют его bucket; для единственного admin это безопасный MVP default. Не включать
  произвольный trustProxy=true ради обхода лимита. Dedicated proxy IP policy — отдельная
  эксплуатационная настройка, текущий API её не принимает от браузера.
- Rate state хранит hashed peer identities, не исходный IP; максимум2048 buckets.
  Один node:локальный volume и Linux flock, без NFS/нескольких машин.

Все ответы no-store/nosniff, same-origin CORP, no-referrer, DENY framing и CSP.
Нет CORS allow-origin; credentials и scanner bodies не попадают в access/error logs.
Ошибки содержат безопасный код; validation400 также содержит bounded issues с путём
из известных полей схемы и типом ошибки, чтобы UI мог объяснить проблему URL/hostname.
Динамические ключи, значения из запросов, токены, filesystem paths и stack скрыты.

## Endpoints и контракты

Авторизованный `GET /api/openapi.json` содержит OpenAPI3.0.3, request/response schemas,
cookie auth, CSRF/Origin и response codes. Схемы преобразуются из contracts/Zod;
cross-field refinements дополнительно проверяются runtime, JSON Schema их не заменяет.

| Метод | Путь относительно `/api` | Поведение |
| --- | --- | --- |
| GET | `/health` | Public minimal readiness |
| POST | `/auth/login`, `/auth/logout` | Login / revoke |
| GET | `/me` | Session / CSRF |
| GET/POST | `/projects` | Page / create201 |
| GET/PATCH/DELETE | `/projects/:id` | Profile / patch / archive |
| POST | `/projects/:id/validate` | Config validation + source preflight operation202 |
| GET | `/projects/:id/operations/:operationId` | Durable operation status/result |
| POST/GET | `/projects/:id/scans` | Enqueue202 / history page |
| GET | `/projects/:id/scans/:scanId` | Manifest + committed analysis progress |
| POST | `/projects/:id/scans/:scanId/cancel` | Control message202, even while worker holds scan lock |
| POST | `/projects/:id/scans/:scanId/resume` | Durable resume operation202 |
| GET | `/projects/:id/scans/:scanId/summary` | Ready report summary |
| GET | `/projects/:id/scans/:scanId/findings` | Seek/filter page |
| GET | `/projects/:id/scans/:scanId/findings/:findingId` | Evidence within selected project/scan |
| POST/GET | `/projects/:id/scans/:scanId/compare/:otherId` | Queue comparison / read ready diff |
| GET | `/projects/:id/scans/:scanId/download/:kind` | Whitelisted attachment |

Single admin видит все проекты инсталляции; это не RBAC/tenant isolation. Каждый scan,
finding и operation проверяются внутри выбранного проекта, не ищутся глобально по ID.
Safe IDs, runtime validation и запрет child symlinks не позволяют выбирать filesystem path.
DATA_DIR — доверенный локальный volume; произвольный writer с тем же Unix UID вне threat model.

Project PATCH: только изменяемые top-level поля, nested object заменяется целиком.
Опциональный If-Match равен revision из ProjectView (с quotes либо без); mismatch409.
Archive/restore — отдельный PATCH `{archived:true/false}`. Смешивать archive и config
одним PATCH нельзя: каждая операция атомарна. DELETE означает archive, не удаление истории.
Queued/running/interrupted scan либо pending operation блокирует изменение проекта409.
Уже созданные scan/project/rules snapshots не редактируются.

Start body optional `{scanId,rules}`; scanId — idempotency key. Повтор того же scan/config
не создаёт новый запуск. Другой активный запуск →409 с currentScanId. Job capacity/lock
тоже409. Web записывает queue/control messages и не импортирует worker/crawler в handler.

Resume доступен для interrupted/incomplete/canceled; API не меняет manifest в running.
Worker берёт durable command после restart, соблюдает project flock/global pool. Старая
cancel flag очищается при submit; новая отмена до pickup отменяет команду, не теряется.
Manifest остаётся прежним stopped snapshot, пока worker не начнёт работу. Incomplete
с исчерпанными источниками не превращается в completed после повторного exports.

Validate body optional `{config}` (id должен совпасть с path), malformed config400.
Worker делает bounded preflight:1 robots, до20 sitemap samples,1 backend GET; timeout≤5s
на fetch, body≤1 MiB, retries0, без полного каталога. Это reachable check, не доказательство
валидности всего feed/sitemap. Ответ содержит configuredSources/sampled/checks/valid;
robots404 означает стандартное отсутствие robots, а не ошибку. Backend сбои — safe
source facts, не SEO findings. Referenced credentials считывает только worker.

Compare: `otherId` — baseline, `scanId` — более новый. POST202 возвращает operation;
GET до готовности404 и не создаёт файлы (ADR-016). Incomplete/incompatible pairs дают
консервативный unknown по EPIC-06. После пересборки source generation GET409
comparison_stale: повторить POST. Отсутствие findings в неполном after не есть resolved.

Project/history pages: limit1…200, cursor=последний ID, total; изменение списка может
сделать cursor stale409. Findings filters: severity/ruleId/verdict/confidence/source/
entityType/httpStatus/entityId/urlContains; limit/cursor/sort как в docs/reports.md.
Сортировка asc/desc по порядку появления, не произвольному столбцу. При поиске total
может быть null, пустая страница с nextCursor требует продолжения; бюджет10k candidates.
Diff query: status/limit/cursor/sort. Browser body limit1 MiB, query/IDs/limits bounded.

Download kinds: json (streamed object summary+findings array), jsonl, csv, html,
summary, manifest, errors, analysis-errors. Передаются attachment, без пользовательского
имени файла/пути. JSON/JSONL/CSV/HTML не читаются целиком в web memory. Ошибки и manifest
не раскрывают env/headers/bodies; errors требуют stopped scan. HTML снабжён sandbox CSP.
HTML-disabled →404. Auth необходим также для HEAD и скачиваний, URL не является секретом.

## Файлы, совместимость, проверка

Новые additive formats1.0: auth/sessions/HASH.json, auth/rate.json,
projects/ID/archive.json и operations/UUID.json. Worker — единственный writer scan WAL
и command results; web создаёт только requests/profile/archive/session/control files.
Сохраняются последние50 операций на проект,32 сессии; reports и scans — прежний retention.
Старый project.json читается с archived=false; scan checkpoint1.0/1.1 остаются прежними.

`npm run check` включает auth/privacy/SSRF-reference/CRUD/queue/compare/download/traversal,
реальные local HTTP sockets и прежний 100k report/index/diff child с heap cap96 MiB.
`node scripts/smoke-api.mjs` — disposable auth+worker+exports HTTP smoke без production URL.
В runtime image (после сборки, без изменения deployment credentials):

```bash
DOCKER_CONFIG=/workspace/.docker-hsi docker compose -f deploy/compose.yaml exec -T inspector-web node --input-type=module < scripts/smoke-api.mjs
```

Команды выполняются из корня checkout; внутри image working directory=/app.
Smoke создаёт отдельное временное хранилище, не использует пользовательский ADMIN hash
и не изменяет deployment configuration. Нельзя выдавать local smoke за готовый browser UI:
AC-03 API часть выполнена в E07, UI форма остаётся E08.
