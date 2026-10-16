# Веб-панель — EPIC-08

Русская React SPA раздаётся Fastify из `apps/ui/dist`. После сборки отдельный Vite
сервер не нужен. Корень `/` и точные имена собранных JS/CSS доступны для входа;
профили, сканы, OpenAPI, доказательства и все выгрузки требуют admin-сессию.
Каталог данных не раздаётся статически, неизвестные пути не получают SPA fallback.

## Запуск и авторизация

1. Установить зависимости и собрать: `npm ci --ignore-scripts && npm run build`.
2. Оператор задаёт `ADMIN_PASSWORD_HASH` и точный HTTPS `PUBLIC_ORIGIN` согласно
   [инструкции API](api-auth.md). В чате пароль не нужен.
3. Запустить web и worker, подключить собственный HTTPS reverse proxy с сохранением
   Cookie и Origin. Не публиковать HTTP-порт напрямую. Готовый эксплуатационный
   TLS/backup/scheduler runbook: [deployment.md](deployment.md).
4. Открыть свой HTTPS origin и войти. Без настроенного admin экран входа доступен,
   но login503 и private API401; данных в HTML нет.

Cookie HttpOnly/Secure/SameSite=Strict; CSRF и session view живут только в памяти.
LocalStorage/sessionStorage не используются. После абсолютного expiry,401 или
CSRF rejection интерфейс очищает приватные данные и показывает вход. Повторный
вход не повторяет незавершённую mutation автоматически. Logout отзывает сессию
на сервере; при сетевой ошибке выхода панель сообщает об ошибке и позволяет повторить.
CSP запрещает внешние/inline scripts/styles, unsafe HTML и сторонние ресурсы.
Нет CDN, аналитики, телеметрии или вызовов crawler из браузера.

## Рабочие сценарии

- **Проекты:** карточки последнего запуска, completeness, P0/P1/P2/INFO/needs_review,
  ограниченные страницы. Счётчики карточки относятся к последнему отчёту, не ко
  всему каталогу проектов. Полоса показывает долю P0/P1, не «оценку SEO».
- **Подключение сайта:** ID, name, base URL, allowlist, sitemap/seeds, URL/query/canonical
  policy, HTTP limits, backend feed, retention/HTML. Многострочные списки — один
  элемент в строке. Runtime schema показывает поля ошибок. Предпросмотр доступен
  только валидной конфигурации, секреты вводить нельзя.
- **Backend:** разрешены только публичный HTTPS и имя `tokenEnv`; значение токена
  оператор передаёт worker отдельно. Web API проверяет привязку ENV reference к origin.
- **Настройки:** ID неизменяем, сохранение использует revision/If-Match. При409 нужно
  перечитать профиль перед повтором. Для сохранённого проекта доступна проверка
  текущего draft без сохранения. Новый профиль сначала сохраняется, затем проверяется.
  Архивация сохраняет историю; восстановление выполняется отдельной операцией.
- **Источники:** проверка ставится в worker;202 отображается как операция queued/running,
  затем результат либо безопасный код ошибки. Даже успешный preflight — ограниченная
  выборка, а не доказательство полного каталога. Повторная проверка не сохраняет draft.
- **Расписание (EPIC-09):** opt-in checkbox, числовой cron из пяти полей и IANA timezone.
  Ошибки календаря отклоняются API. Снятие флажка удаляет расписание; worker также
  требует `SCHEDULER_ENABLED=true`. Карточка показывает последний сохранённый scheduler
  snapshot и ссылку на последний автоматический scan, с ручным обновлением. Это не heartbeat.
- **Сканы:** ручной полный запуск; отмена — запрос, состояние меняется по подтверждению
  worker. Для interrupted/incomplete/canceled есть «Продолжить»; новый полный запуск
  создаёт отдельный immutable scan. Конфликт409 показывает текущий scan ID и ссылку.
  Счётчики подтверждены checkpoint. До окончания discovery знаменатель неизвестен,
  поэтому искусственный процент «готово100%» не выводится.
- **Неполный скан:** заметный INCOMPLETE, manifest reasons, ошибки источников/HTTP,
  отдельный постраничный журнал непроверенных источников/лимитов. Он не является
  SEO-находками. Недоступный отчёт явно обозначен; manifest доступен и до завершения.
- **Находки:** severity/verdict/rule/source/entity type/confidence/HTTP/entity ID/URL,
  порядок появления asc/desc. Сброс фильтра начинает новую цепочку cursors. На странице
  максимум50 записей; UI не объединяет весь каталог в массив. Пустая страница с cursor
  имеет активную «Далее»; total=null показывается как «неизвестно».
- **Доказательства:** отдельный запрос при открытии карточки; expected/actual, confidence,
  entity, source page, JSON path, bounded excerpt и рекомендация. React выводит target
  HTML текстом, не вставляет его в DOM. Полная HTTP-цепочка не входит в существующий
  Finding DTO; интерфейс прямо говорит, что эти сведения отсутствуют.
- **Экспорт:** обычные same-origin ссылки на private attachment, без скачивания всего
  файла в JavaScript Blob. CSV/JSON/JSONL/HTML/summary/manifest/errors/analysis-errors;
  HTML требует включённой генерации. Incomplete watermark формируется сервером.
- **Сравнение:** `otherId` — более ранний baseline; GET только читает. POST ставит
  worker operation, UI ждёт завершения. New/persisting/resolved/unknown и reason;
  неполный after не превращает исчезнувшие строки в resolved. При stale generation
  сравнение строится заново. Delta CSV/JSONL/HTML содержит всё сравнение, без фильтра
  текущей UI страницы. Для baseline старше200 запусков можно ввести ID вручную.
- **Система:** реальный health web/volume, границы анализа, ссылки на настройки хранения.
  Worker heartbeat/свободный диск API не предоставляет — UI не придумывает эти метрики.

Polling имеет один запрос за раз на ресурс, интервал2–4с для активных операций/истории,
10с для health; на скрытой вкладке останавливается, при смене экрана запросы abort.
Завершённые scan/operation не опрашиваются постоянно. История показывает динамику
обработанных/обнаруженных URL; это не график позиций или поисковой индексации.

## Контракты EPIC-08

- `GET /api/projects/:id/scans/:scanId/diagnostics?limit=50&cursor=…` — только stopped
  snapshot; максимум100 строк и256 KiB чтения на запрос. Cursor связан с project/scan
  и размером/mtime/identity файла. Изменение snapshot →409, начать с первой страницы.
  Ответ `ScanDiagnosticsPageSchema`, элементы `DiscoveryIssueSchema`.
- `GET /api/projects/:id/scans/:scanId/compare/:otherId/download/:kind` — whitelist
  csv/jsonl/html, проверка source generations как при GET comparison, streaming attachment,
  no-store/nosniff/sandbox CSP. Запрос не строит diff и не обращается к target.

API schemas добавлены без изменений persisted formats1.0/1.1 и без миграции данных.

## Проверки браузера

```bash
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

В подготовленной cloud среде есть системный Chromium, поэтому загрузка не нужна:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e
```

Fixture запускает только на127.0.0.1:4178 одноразовый TLS proxy, HSI и worker с отдельным
временным DATA_DIR. Полностью file-backed dataset содержит10001 находку и неполный
повторный отчёт; динамические операции идут через настоящий API/worker. Для lifecycle
используются synthetic projects без URL, preflight transport отображает только
shop.example.com в локальный тестовый HTTPS сервер. Target-сайты в Playwright не открываются.
Browser network guard разрешает только origin панели; malicious evidence не делает запросов.

Проверка доверяет SPKI только сохранённого synthetic test certificate. Глобальный
ignoreHTTPSErrors и ослабление production TLS не используются. Chromium-флаг относится
только к тестовому браузеру, не к runtime HSI. Test certificate/key — публичные фикстуры,
не deployment credentials. Куки остаются в памяти тестов, storageState не записывается.
Trace/video/screenshots выключены; optional HSI_UI_SCREENSHOT сохраняет только synthetic UI.
Выходные test-results/playwright-report игнорируются Git и Docker.

Проверены русский UI, labels, клавиатурный skip-link, responsive390px и отсутствие
CSP-ошибок. Это базовая проверка доступности, не полный WCAG-аудит. Основной browser
matrix — Chromium; Firefox/WebKit и реальные production TLS настройки здесь не проверены.
