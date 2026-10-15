# Разработка: EPIC-01…07

Требуется Node.js 24.19.0 (major 24), npm 11; Docker Engine + Compose v2 для контейнеров.
Все команды из корня checkout, без worktree и глобальных npm install.

```bash
npm ci --ignore-scripts
npm run check
npm run smoke
```

`check`: ESLint, TypeScript (включая тесты и UI), Vitest, сборка всех пакетов и UI.
`smoke`: отдельный запуск web и worker на свободных localhost портах, проверка health,
401 для проектов, SIGTERM и exit 0. Использует временный каталог, не production /data.

## Локальные процессы

После `npm run build` в двух терминалах:

```bash
DATA_DIR=./data HOST=127.0.0.1 PORT=3000 npm run start:web
DATA_DIR=./data HOST=127.0.0.1 PORT=3001 npm run start:worker
```

Проверить локальным запросом `GET /api/health`: HTTP 200 и `{"status":"ok"}`.
Health проверяет создание, fsync и rename временного файла, удаляя probe после проверки;
он не возвращает пути, project counts, конфигурацию или секреты.
Недоступное хранилище даёт 503 без подробностей. Без auth конфигурации private routes — 401; login503, health200. При настроенном admin API работает по сессии; root после входа пока404 (UI — E08).
Login и защищённый API реализованы. UI только собирается; браузерная панель — EPIC-08.
Packages sources/reports реализуют discovery/HTML facts и report/diff orchestration через файловые адаптеры.
Zod URL checks не являются SSRF защитой. EPIC-02 добавляет SafeHttpClient с DNS/IP pinning; см. docs/http-client.md.
Схемы не являются sanitizer HTML/PII: перед записью нужен redaction этап EPIC-05/06.

## Docker

```bash
docker compose -f deploy/compose.yaml up -d --build --wait
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml down
```

В облачной среде стандартный `~/.docker` read-only. Использовать
`DOCKER_CONFIG=/workspace/.docker-hsi` перед Docker-командами; это исправление пути
конфигурации, без отключения TLS и без копирования credentials.
Если bridge DNS/прокси требуют CA облачной среды, использовать:

```bash
node scripts/cloud-docker-build.mjs
DOCKER_CONFIG=/workspace/.docker-hsi docker compose -f deploy/compose.yaml up -d --wait
```

Helper разрешает имя proxy через DNS/hosts среды, добавляет его в BuildKit extra_hosts,
включает host network только для build и передаёт доверенный публичный CA
через BuildKit secret, не в image. Значения proxy не сохраняются в файлы.
Проверка TLS и npm integrity остаются включёнными; runtime сеть не меняется.

Контейнеры: UID node, root FS read-only, /tmp tmpfs, общий именованный volume /data.
Worker не публикует порт, web привязан к localhost:3000. Публикация требует настроенного admin и внешнего HTTPS reverse proxy. Auth/session/CSRF реализованы в EPIC-07, TLS deployment — EPIC-09.
`down` сохраняет данные; `down -v` допустим только для disposable smoke environment.
Не удалять пользовательский volume в setup script.

## AI Factory

AI Factory 2.19.0 установлен вне приложения: `/workspace/tools/ai-factory`.
Использовать `/workspace/tools/ai-factory/node_modules/.bin/ai-factory --version`.
Для новой локальной машины:

```bash
npm install --prefix ../hsi-tools --ignore-scripts --save-exact ai-factory@2.19.0
```

Навыки уже сохранены в `.agents/skills`: aif-architecture, aif-plan, aif-review.
MCP/расширения выключены. Не запускать `$aif` bootstrap: он не установлен и может
подбирать внешние навыки. Не запускать update/init поверх конфигурации автоматически.
Handoff/публикация ревью запрещены project overrides, даже если внешний skill их предлагает.
См. `.ai-factory/RULES.md` и `docs/skill-security.md`.

## Приёмка

Контрактные fixtures двух сайтов проверяют переносимость конфигурации, не сканирование.
AC-01/04 продукта пока частично покрыты; весь MVP и остальные AC не заявлены выполненными.
HTTP library и discovery/Entity Feed реализованы; см. docs/discovery.md. Durable lifecycle/locks/resume: см. docs/durable-storage.md. EPIC-05 SEO pipeline: см. docs/seo-rules.md. EPIC-06 отчёты/seek/diff: см. docs/reports.md. EPIC-07 auth/API: см. docs/api-auth.md. Далее EPIC-08: browser UI.
Никаких production сканов без разрешения владельца.

Для durable worker требуется Linux `/usr/bin/flock`; Dockerfile проверяет наличие.
`JOB_CONCURRENCY=2` должен совпадать с CLI `--concurrency` и сохранённым pool.json.
