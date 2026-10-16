# Разработка: EPIC-01…09

Требуется Node.js 24.19.0 (major 24), npm 11; Docker Engine + Compose v2 для контейнеров.
Все команды из корня checkout, без worktree и глобальных npm install.

Кэш npm использует стандартный путь текущего пользователя. Не фиксируйте абсолютный
путь облачной среды в `.npmrc`: на GitHub Actions он может быть недоступен для записи.
При необходимости задайте локальное переопределение через `npm_config_cache`.

```bash
npm ci --ignore-scripts
npm run check
npm run smoke
```

`check`: ESLint, TypeScript (включая тесты и UI), Vitest, сборка всех пакетов и UI.
`smoke`: отдельный запуск web и worker на свободных localhost портах, проверка health,
401 для проектов, SIGTERM и exit 0. Использует временный каталог, не production /data.

Локальные переменные объявляйте через `const` перед первым использованием в самой
узкой подходящей области; `let` нужен для переназначения. Поля класса размещайте
перед конструктором и методами. Сохраняйте порядок вычисления инициализаторов.
ESLint проверяет обращения до объявления и порядок членов класса; именованные
функции допускают hoisting, ссылки только на типы не ограничены.
Проверка объединения веток: [sum1-7](SUM1-7-RESULTS.md).

## Локальные процессы

После `npm run build` в двух терминалах:

```bash
DATA_DIR=./data HOST=127.0.0.1 PORT=3000 npm run start:web
DATA_DIR=./data HOST=127.0.0.1 PORT=3001 npm run start:worker
```

Проверить локальным запросом `GET /api/health`: HTTP 200 и `{"status":"ok"}`.
Health проверяет создание, fsync и rename временного файла, удаляя probe после проверки;
он не возвращает пути, project counts, конфигурацию или секреты.
Недоступное хранилище даёт 503 без подробностей. Без auth конфигурации private routes — 401; login503, health200. При настроенном admin API работает по сессии. Корень раздаёт login shell; приватные данные загружаются после входа.
Русская панель реализована в EPIC-08, настройки cron — в EPIC-09.
Packages sources/reports реализуют discovery/HTML facts и report/diff orchestration через файловые адаптеры.
Zod URL checks не являются SSRF защитой. SafeHttpClient реализует с DNS/IP pinning; см. docs/http-client.md.
Схемы не являются sanitizer HTML/PII: pipeline EPIC-05/06 применяет redaction перед записью.

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
Worker не публикует порт, web привязан к localhost:3000. Публикация требует настроенного admin и внешнего HTTPS reverse proxy. Auth/session/CSRF реализованы в EPIC-07, TLS deployment реализован в EPIC-09: [runbook](deployment.md).
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
HTTP library и discovery/Entity Feed реализованы; см. docs/discovery.md. Durable lifecycle/locks/resume: см. docs/durable-storage.md. EPIC-05 SEO pipeline: см. docs/seo-rules.md. EPIC-06 отчёты/seek/diff: см. docs/reports.md. EPIC-07 auth/API: см. docs/api-auth.md. Русская SPA и browser tests: см. docs/web-ui.md. EPIC-09: [scheduler/TLS/backup](deployment.md) и [security review](EPIC-09-SECURITY-REVIEW.md). EPIC-10: [demo/load/pilot](pilot.md) и [AC matrix](ACCEPTANCE-MATRIX.md).
Никаких production сканов без разрешения владельца.

Для durable worker требуется Linux `/usr/bin/flock`; Dockerfile проверяет наличие.
`JOB_CONCURRENCY=2` должен совпадать с CLI `--concurrency` и сохранённым pool.json.

## Browser acceptance EPIC-08

После build: `npx playwright install --with-deps chromium && npm run test:e2e`.
В этой cloud среде Chromium уже установлен; используйте
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e`.
Операторские auth env не нужны для тестов: TLS fixture имеет отдельные синтетические
credentials и временное DATA_DIR. Порт127.0.0.1:4178 должен быть свободен; чужой процесс
не переиспользуется. Только собственная панель, без production targets.
Подробности, контракты и ограничения: [web-ui.md](web-ui.md).

## Планировщик и эксплуатация EPIC-09

По умолчанию `SCHEDULER_ENABLED=false`. Для локальных сценариев используйте synthetic
профиль без внешних URL; включение расписаний реальных сайтов требует разрешения владельца.
`npm run backup -- create|restore --offline --source PATH --target NEW_PATH` — только после
остановки всех writers; целевой каталог должен отсутствовать. TLS overlay, необходимые
права, порядок восстановления и ограничения: [deployment.md](deployment.md).
После сборки production image: `node scripts/smoke-tls.mjs`; backup smoke можно выполнить
в runtime image через `node --input-type=module < scripts/smoke-backup.mjs`.

## EPIC-10: воспроизводимая приёмка

`npm run demo` после build выполняет два локальных synthetic сайта через настоящий worker.
Тест `pilot-demo.test.ts` входит в check; `npm run benchmark:pipeline` — отдельная долгая
нагрузка10k/100k с cap128 MiB. Не запускайте её одновременно с check/report-memory: они
делят CPU/fsync и могут исчерпать timeout тестового runner. Docker tmpfs вариант и его
границы описаны в [pilot.md](pilot.md). Никаких настоящих сканов для запуска не требуется.
