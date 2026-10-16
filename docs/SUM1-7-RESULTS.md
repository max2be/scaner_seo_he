# Объединение EPIC-01…07 в sum1-7

Ветка `sum1-7` объединяет текущую реализацию EPIC-01…07 с историей `main`.
Отдельных семи веток в origin нет: EPIC-01…06 сохранены последовательными
коммитами в `feat/epics-01-04`, а EPIC-07 был сохранён из рабочего checkout.

## Источники и конфликты

| Источник | Коммит | Содержание |
| --- | --- | --- |
| `origin/main` | `a1f75ea` | PR#1 с ранней реализацией EPIC-01 |
| `origin/feat/epic-01-foundation` | `dd2a57b` | Альтернативный ранний каркас |
| `origin/feat/epics-01-04` | `6886c3b` | EPIC-01…06; название ветки историческое |
| Рабочий checkout EPIC-07 | `cbadfc3` | Authenticated API и проверки EPIC-07 |
| Merge в `sum1-7` | `4364ecf` | Обе истории сохранены настоящим merge |

Разрешены 23 конфликта add/add: корневые package/TS/Vitest/ignore/CI/Docker
конфигурации, UI entrypoint и package manifests приложений, manifests и index.ts
пакетов contracts/core/reports/sources/storage, contracts tests.
Сохранена проверенная реализация EPIC-01…07. Все исходные ветки являются её предками.

Удалены устаревшие входные точки `apps/web/src/server.ts`, `apps/worker/src/worker.ts`,
корневой `compose.yaml`, дублирующий `eslint.config.mjs` и несовместимый с текущей
сборкой `apps/ui/vite.config.ts`. Актуальные entrypoints — `main.ts`, конфигурации —
`deploy/compose.yaml` и `eslint.config.js`. Исторические документы раннего каркаса
сохранены в `docs/history/epic-01-foundation/`; устранена коллизия имён
`decisions.md` / `DECISIONS.md` для файловых систем без учёта регистра.
Примеры переменных окружения приведены к текущему API без секретных значений.

## Объявления переменных и полей

По уточнённому выбору пользователя: `const` непосредственно перед первым
использованием в узкой области видимости, `let` при переназначении, поля класса
перед конструктором и методами. Порядок вычисления инициализаторов сохраняется.
Именованные функции допускают hoisting; ссылки только на типы освобождены от ограничения.

Проверены 100 исходных файлов TS/TSX/MJS приложений, пакетов, скриптов и тестов.
В RequestScheduler именованный callback позволяет убрать ссылку на переменную
выше объявления; в FileLease конструктор перемещён перед методами.
ESLint проверяет обращения до объявления, `prefer-const`, запрет `var` и порядок
полей/конструктора/методов. Четыре теста проверяют действие правил.
Массового переноса переменных в начало функций нет.

## Проверки

- Чистая установка: `npm ci --ignore-scripts` успешна.
- `npm run check`: ESLint, TypeScript, **416 тестов в 25 файлах**, сборка пакетов и UI — успешно.
- Проверка отчётов/diff на 100 000 URL: heap 71,90 MiB, RSS 185,60 MiB
  при V8 heap cap 96 MiB; seek просмотрел 10 записей, 3,65 мс.
  Полный benchmark занял 96,46 с в этой среде; это измерение проверки, не SLA.
- `npm run smoke` и real-socket API smoke — успешно.
- Docker production image собран; Compose config и запуск с ожиданием health — успешно.
- В production image пройдены synthetic API и reports smoke: auth/session/CSRF,
  очередь и worker resume, приватные экспорты, отчёты/pagination/rebuild/diff, nonroot runtime.
- `git diff --check`, отсутствие unmerged entries и проверка ancestry исходных веток — успешно.

Smoke использует синтетические данные и не сканирует production сайты. Навыки не
обновлялись и не синхронизировались с внешними сервисами. PRD, ТЗ и backlog сохранены.
Для реального browser deployment по-прежнему нужны операторские auth-настройки и HTTPS.

Следующий этап — EPIC-08 после приёмки этой ветки: UI поверх готового API,
с учётом nullable totals, cursor pagination и асинхронных операций. EPIC-08 не начат.

## Переносимость npm cache в CI

После сообщения о падении GitHub Actions обнаружен абсолютный
`cache=/workspace/.npm-cache` в корневом `.npmrc`. На обычном runner путь вне home
может быть недоступен пользователю. Изолированный nonroot-контейнер без сети
воспроизводит `npm ci --ignore-scripts --offline` на локальном tarball:
исходная настройка даёт `EACCES: permission denied, mkdir '/workspace'`,
стандартный пользовательский кэш — успешную установку.

Абсолютный путь удалён; `actions/setup-node` с `cache: npm` определяет стандартный
кэш npm. Для ограниченной cloud sandbox локальный путь при необходимости задаётся
переменной `npm_config_cache`, а не общим конфигурационным файлом проекта.
GitHub API из среды отвечает Forbidden, поэтому лог конкретного падения не прочитан;
это воспроизведённый дефект конфигурации, а подтверждение успешного Actions run
требует проверки нового запуска в GitHub после push.
После исправления повторно пройдены чистая установка, `npm run check`
(416 тестов в 25 файлах, lint/typecheck/build) и `npm run smoke`.

## CI: бюджет process integration test SIGTERM

В предоставленном пользователем логе GitHub Actions прошли lint/typecheck и415
из416 тестов. Единственное падение — `tests/durable-flow.test.ts`, сценарий
`survives SIGTERM ...`, общий Vitest timeout5000ms. Лог не указывает конкретную
долгую фазу, поэтому зависание runtime по нему не установлено. Отдельный локальный
прогон исходного сценария прошёл примерно за0,7с.

Для двух real-process сценариев SIGKILL/SIGTERM задан общий budget20с, учитывающий
запуск Node/guardians, fsync, завершение, resume и генерацию отчётов. Ожидание
первого committed request и остановки worker имеет отдельные deadline5с с названием
фазы ошибки. SIGTERM обязан завершиться с exit0 без signal; SIGKILL проверяется
отдельно. На освобождение guardian lease проверяется реальное условие с ограниченным
polling, вместо30 немедленных попыток без итогового assertion. Exit listener
регистрируется сразу после spawn, stdout/stderr дренируются, child cleanup выполняется
также через onTestFinished при внешнем timeout.

Проверки checkpoint, duplicate conflict, interrupted, полного resume и отсутствия
повторного запроса committed страницы сохранены. Runtime и глобальные test timeouts
не менялись; retry/skip отсутствуют. Целевой прогон durable-flow+durable-storage:
28 тестов прошли. Дополнительно проверен чистый файловый снимок опубликованного
`sum1-7` без незакоммиченного EPIC-08: clean install, lint/typecheck/build,
416 тестов в25 файлах (включая100k benchmark), web/worker smoke — успешно.
В этом полном прогоне SIGTERM занял0,54с. Это локальная проверка отправляемого CI-fix,
а не подтверждение нового зелёного запуска GitHub Actions; его результат проверяется
после push в GitHub.
