# Headless SEO Inspector — Functional & Technical Specification

**Версия:** 1.0 · **Основание:** `01_PRD.md` · **Назначение:** источник истины при программировании через Codex.

> Требования `MUST` обязательны для MVP, `SHOULD` желательны после основных тестов, `MAY` для V2. Если пример и правило расходятся, действует текст правила. Нельзя незаметно упрощать full scan до случайной выборки. **(!!!!!)** означает архитектурное предположение.

## 1. Предлагаемый стек

- Runtime: **Node.js LTS + TypeScript**; сервер/API: **Fastify**; UI: **React + Vite** (статические сборки через Fastify); валидация конфигураций: **Zod**; HTML parser: **parse5/Cheerio**; XML streaming parser с отключёнными внешними сущностями; HTTP: клиент с настраиваемым connector, запретом авто-redirect и сетевой валидацией; tests: **Vitest**; e2e: Playwright **только для тестирования собственного UI**, не для сканирования целевого сайта.
- Docker Compose: `inspector-web` и `inspector-worker`, единый versioned image, общий volume `/data`, health checks, непривилегированный user, read-only root FS где возможно.
- **Нет** SQL, Redis, Elasticsearch и SaaS-зависимостей в MVP. Все persistent сущности — JSON/JSONL/CSV/HTML на общем диске.
- Компоненты не импортируют файлы/классы Битрикса и не содержат домен sabosports.ru вне fixtures/examples.

## 2. Декомпозиция и файлы

```text
/apps/web/              Fastify REST, auth, presentation API, статическая UI-сборка
/apps/worker/           Очередь, discovery, fetcher, rule engine, report writer, scheduler
/apps/ui/               React UI: projects/scans/findings/details/diff/settings
/packages/contracts/    Схемы TS + Zod, DTO, стабильные enums
/packages/core/         URL normalization, HTTP policy, parsing, SEO rules
/packages/sources/      sitemap, href crawler, generic API/JSON feed
/packages/storage/      Atomic JSON files, JSONL append, locks, indexes, retention
/packages/reports/      JSON/CSV/HTML, diff, escaping, redaction
/tests/fixtures/       Тестовые HTML, JSON-LD, sitemap, fake HTTP, fake backend
/examples/             Demo config + demo entity feed, без реальных токенов
/deploy/               Dockerfile, compose.yaml, .env.example, sample reverse proxy
/docs/                 PRD, spec, runbook, security, limitations, deployment
```

Поток: `ProjectConfig -> Discovery (seeds+sitemaps+links+entity feed) -> Durable URL queue -> Safe HTTP GET -> Parse source HTML -> RuleEngine -> Disk findings -> Summary/Indexes -> Authenticated Web UI`.

Компоненты логически разделены интерфейсами; выполнение сканирования не зависит от запущенного веб-процесса.

## 3. Контракт конфигурации `project.json`

Пример также вынесен в `examples/project.example.json`.

```json
{
  "schemaVersion": "1.0",
  "id": "sample-shop",
  "name": "Example Headless Shop",
  "baseUrl": "https://shop.example.com",
  "allowedHosts": ["shop.example.com"],
  "discovery": {
    "sitemapUrls": ["https://shop.example.com/sitemap.xml"],
    "seedUrls": ["https://shop.example.com/"],
    "crawlLinks": true,
    "maxDepth": 8,
    "queryPolicy": {"mode": "allowlist", "allowedKeys": ["page"], "dropTrackingKeys": ["utm_*", "gclid", "yclid"]},
    "maxUrls": 100000
  },
  "canonicalPolicy": {
    "trailingSlash": "unknown",
    "expectedScheme": "https",
    "preferredHost": "shop.example.com",
    "checkSelfCanonical": false
  },
  "http": {
    "userAgent": "HeadlessSEOInspector/1.0 (+site-owner-diagnostic)",
    "respectRobots": true,
    "requestsPerSecondPerHost": 1,
    "concurrency": 2,
    "timeoutMs": 15000,
    "maxResponseBytes": 5000000,
    "maxRedirects": 8,
    "maxRetries": 2
  },
  "sources": {
    "backend": {
      "enabled": true,
      "type": "entity-feed-v1",
      "endpoint": "https://feed.example.com/v1/seo/entities",
      "auth": {"type": "bearer", "tokenEnv": "EXAMPLE_FEED_TOKEN"},
      "pageSize": 500
    }
  },
  "reports": {"keepLastRuns": 12, "htmlEnabled": true}
}
```

**Validation:** уникальные project IDs; все fetch destinations допускаются `allowedHosts` публичного сайта или отдельным `backend.allowedHosts`; URL с userinfo, нестандартными схемами и приватными IP запрещены по умолчанию. `maxUrls` — мягкий операционный guardrail: при достижении лимита запуск `incomplete` и уведомление, пользователь может увеличить ограничение и продолжить, full scope не декларируется покрытым.

`trailingSlash="unknown"` означает: выводить обе формы и их ответы, но не назначать ошибку «неправильный слеш». `without` и `with` — явное соглашение проекта, `preserve` — сравнивать с backend/source canonical без глобальной коррекции.

## 4. Контракт backend — Entity Feed v1

Сканер получает JSON **только read-only**. Пагинация cursor-based — рекомендуемый дефолт, `nextCursor=null` означает завершение. При отсутствии backend source standalone работает полноценно, но не может сказать, какие отсутствующие страницы *должны* существовать.

### GET `/v1/seo/entities?cursor=...&limit=500`

```json
{
  "schemaVersion": "1.0",
  "snapshotId": "2026-10-14T12:00:00Z",
  "items": [
    {
      "id": "sku-981",
      "type": "product",
      "url": "https://shop.example.com/catalog/shoes/model-x",
      "publicationState": "published",
      "expectedIndexable": true,
      "expectedStatus": 200,
      "canonicalUrl": "https://shop.example.com/catalog/shoes/model-x",
      "updatedAt": "2026-10-14T11:00:00Z",
      "data": {"title": "Model X", "sku": "MX-1", "price": 12000, "currency": "RUB", "availability": "InStock"}
    },
    {
      "id": "section-14",
      "type": "category",
      "url": "https://shop.example.com/catalog/shoes",
      "publicationState": "published",
      "expectedIndexable": true,
      "expectedStatus": 200
    },
    {
      "id": "article-6",
      "type": "page",
      "url": "https://shop.example.com/articles/select-shoes",
      "publicationState": "published",
      "expectedIndexable": true
    }
  ],
  "nextCursor": null
}
```

**Типы:** `product|category|page`; состояния `published|unpublished|deleted|redirected|unknown`. Для `redirected`: `redirectTargetUrl` обязателен; 301/308 допускаются, если политика не говорит иное. Для `unpublished/deleted` нельзя автоматически требовать 404: возможны 200/noindex, 410, корректный redirect; ожидаемое действие задаёт фид или политика типа страницы.

**API error policy:** 401/403, timeout, malformed JSON, pagination loop, смена `snapshotId` во время продолжительной выгрузки => `source_error`; зависимые находки имеют `needs_review`, не «товар удалён». Без `snapshotId` результат помечается `snapshot_consistency=unknown`.

**Generic adapter options:** MVP принимает любой endpoint, соблюдающий Entity Feed v1. Для чужого API без такого ответа нужен маленький transformer/proxy (отдельный пакет, без модификаций HSI core). Для API с простыми map полей можно добавить декларативный mapping в V1.1, но не раздувать MVP.

## 5. Поток URL discovery

1. Провалидировать project config и whitelist сетевых адресов.
2. Запросить `robots.txt`; если нет/недоступен, зафиксировать факт и применить безопасную политику retry/skip в зависимости от HTTP-кода, не объявлять отказ неизвестной страницы.
3. Импортировать sitemap indexes / XML `<loc>` потоково и дочерние карты; защититься от recursive loops, gzip bomb и небезопасных XML сущностей; соблюдать 50k URL/50MB per sitemap, фиксировать нарушение.
4. Импортировать backend feed до окончания snapshot; дедуплицировать URLs, сохранить `sourceSet` и `entityRefs`.
5. Добавить seed URL; выполнять BFS по ссылкам из **server HTML** в границах depth/query/allowlist. Не конструировать неограниченные URL; `rel=nofollow` и robots влияют на политику согласно настройкам.
6. Протоколировать `discovered/queued/fetched/skipped/errors` с origin и page type; страница может одновременно быть из sitemap, ссылки и backend.
7. Зафиксировать `discoveryComplete=true` только когда все страницы sitemap index/все страницы backend/все поставленные в очередь ссылки обработаны без неразрешённых ограничений.

`href` в HTML может быть абсолютным, относительным, `#anchor`, `mailto:`, `tel:`, JavaScript pseudo-URL или вне домена; проверка внутренних HTTP ссылок — только для разрешённых HTTP(S)-целей. Не скачивать внешние сайты без явно внесённых `allowedHosts`.

## 6. HTTP/fetcher и фиксация доказательств

Сканер MUST использовать GET; HEAD не является источником статуса страницы. Redirect handling **ручной**: каждый `Location` проходит тот же SSRF/allowlist тест, цепочка сохраняется; max 8 redirects; loop detection. Таймаут отдельно connection/headers/whole request там, где позволяет HTTP клиент.

**Evidence fields:** `requestedUrl`, `responseUrl`, `timestamp`, `method`, `httpStatus`, `redirectChain`, `contentType`, `responseBytes`, `ttfbMs`, `totalMs`, `requestProfile`, `bodySha256`, `htmlExtract` до 4KB **после редактирования чувствительного**; `serverHeader`/`cacheControl` по политике. Не сохранять полный HTML по умолчанию.

По 429 и временным 5xx делать ≤2 bounded retry; учитывать Retry-After; backoff+джиттер; 404 не ретраить бесконечно, но повторить подтверждённый P0 однажды, чтобы исключить transient; записать обе попытки в evidence.

**Robots:** не обойти robots под видом Googlebot; явный user-agent, по умолчанию respectRobots=true. robots `Disallow` означает `skipped_robots`, не фактическое noindex. Для страницы с robots disallow нельзя проверить её содержимое; она не может автоматически получить verdict «ошибочный noindex».

## 7. Список правил и минимальная диагностическая матрица

Каждый `Rule` имеет `(id, version, severityDefault, appliesTo, detect(context), evidence, recommendationKey)`. Detect возвращает `pass|finding|needs_review|not_applicable|scan_error`. `scan_error` не SEO-ошибка.

| ID правила | Условие | Класс / оговорка |
|---|---|---|
| `EXPECTED_PAGE_NOT_200` | Публикуемая indexable entity ожидает 200; подтверждённый HTTP !=200 | P0 для 404/410, 5xx по масштабу; 301/308 оцениваются по конечному URL и политике |
| `UNKNOWN_ROUTE_RETURNS_200` | Контрольный несуществующий URL отвечает 200, и есть достоверный маркер отсутствующей сущности | P1; без маркера -> needs_review; тестовые URL только разрешённые, не создавать случайно существующие |
| `HTTP_SERVER_ERROR` | 5xx на ожидаемой странице | P0/P1 с confidence и повтором |
| `REDIRECT_LOOP` | Повтор URL в redirect chain | P1 |
| `REDIRECT_CHAIN_LONG` | >2 hops на важном URL | P2, настраиваемо |
| `CANONICAL_MISSING` | Нет canonical там, где конфигурация требует | P2; иначе INFO |
| `CANONICAL_CONFLICT` | Несколько конфликтующих canonical или несоответствие policy/expectedCanonical | P1/P2; исключения для неиндексируемых страниц |
| `CANONICAL_TARGET_BROKEN` | Canonical ссылается на разрешённый URL с 404/5xx/петлёй | P1 |
| `SITEMAP_URL_NOT_INDEXABLE` | Sitemap URL ведёт на 404/noindex/редирект не на canonical | P1/P2 с доказательством |
| `EXPECTED_URL_MISSING_FROM_SITEMAP` | Опубликованный indexable URL отсутствует в согласованных картах | P1/P2, если sitemapComplete=true |
| `BROKEN_INTERNAL_LINK` | HTTP href на разрешённый internal URL отвечает 404/410 | P1/P2; обязателен sourcePage/href |
| `ROBOTS_DISALLOWED_EXPECTED` | Опубликованный ожидаемый indexable URL запрещён robots для нашего профиля | P1; не утверждать, что Google проиндексирует/не проиндексирует |
| `NOINDEX_EXPECTED_PAGE` | Опубликованный expected indexable имеет meta/X-Robots noindex | P0/P1 |
| `TITLE_MISSING` | Пустой/отсутствующий title на ожидаемой HTML посадочной странице | P2 |
| `DESCRIPTION_MISSING` | Отсутствует описание | P2/INFO |
| `DUPLICATE_TITLE` | Группа важных индексируемых страниц с одинаковым title | P2, группировать и исключать дубль URL |
| `H1_MISSING` | Нет H1 | P2/INFO, без требования обязательного единственного H1 |
| `JSONLD_PARSE_ERROR` | Не парсится ld+json | P1/P2 |
| `PRODUCT_RATING_COUNT_MISSING` | Есть AggregateRating, но отсутствуют ratingCount и reviewCount | P1, конкретный исходный JSON fragment |
| `PRODUCT_DATA_CONFLICT` | Цена/валюта/наличие расходятся с доверенным backend feed | P1 при сопоставимых данных, иначе needs_review |
| `DUPLICATE_DOM_ID` | Одинаковый id в исходном HTML | P2/INFO, не автоматически P0 |
| `DUPLICATE_MANIFEST` | >1 manifest в исходном HTML | INFO |
| `BUTTON_NAV_SUSPECTED` | Эвристика указывает на button, выполняющий навигацию | needs_review: без JS нельзя подтвердить действие |
| `SSR_CONTENT_MISSING` | 200 HTML без ожидаемых содержательных данных при published entity | needs_review; может быть CSR-приложение |
| `RESPONSE_CONTENT_TYPE_INVALID` | Ожидали HTML, получили ошибочный content-type или иной ресурс | P1/P2 |

`soft 404` по одной лишь визуальной фразе «404» и коду 200 — только `SOFT_404_SUSPECTED/needs_review` до подтверждения специальным marker/feed. Приведённые SEO-аудитором старые 404 при отсутствии expected entity **не создают** `EXPECTED_PAGE_NOT_200`.

## 8. Схема находки и стабильность JSON

```json
{
  "schemaVersion": "1.0",
  "id": "sha256:stable-fingerprint",
  "scanId": "20261014T030000Z_3f92a1",
  "projectId": "sample-shop",
  "ruleId": "PRODUCT_RATING_COUNT_MISSING",
  "ruleVersion": "1.0.0",
  "severity": "P1",
  "verdict": "finding",
  "confidence": "high",
  "url": "https://shop.example.com/catalog/shoes/model-x",
  "entity": {"type": "product", "id": "sku-981"},
  "expected": "aggregateRating includes ratingCount or reviewCount",
  "actual": "aggregateRating.ratingValue=5 only",
  "evidence": {"httpStatus": 200, "source": "server_html", "jsonPath": "$.aggregateRating"},
  "suggestionKey": "correct-product-rating-schema",
  "firstSeenAt": "2026-10-14T03:00:00Z",
  "lastSeenAt": "2026-10-14T03:00:00Z"
}
```

`id/fingerprint`: вычислять из стабильного `projectId+ruleId+normalizedTarget+entity.id(optional)`; для DUPLICATE_TITLE нормализовать группу или выбрать anchor-URL, иначе diff будет шумным. `scanId` не входит в fingerprint. В HTML и CSV все untrusted значения HTML-escape/CSV-escape.

**Confidence:** `high` — факт из HTTP/HTML/доверенного backend; `medium` — эвристика; `low` — неполные данные. `verdict` = `finding|needs_review`, error fetch хранится отдельно. `severity` не относится к сканированию без данных.

## 9. Модель хранения только в файлах

```text
/data/
  projects/<projectId>/project.json
  projects/<projectId>/scans/<scanId>/
    manifest.json             queued/running/completed/incomplete/failed/...
    queue.jsonl               append-only discovered URL journal
    checkpoint.json           offset, worker leases, source cursors, resume tokens
    urls.jsonl                итог запросов, statuses, provenance
    findings.jsonl            диагностика, построчное хранение
    scanner_errors.jsonl      ошибки сканера/источников отдельно от SEO
    summary.json              counters, by-rule, completeness, duration
    findings.csv
    report.html
    finding_index.json        ограниченный UI-index + offsets / bucketing (не весь HTML)
  projects/<projectId>/locks/scan.lock
  auth/sessions/              приватные файлы с expiry и server-side state
  logs/
```

Запись `.json` только через `write tmp -> fsync (где применимо) -> rename`, `jsonl` последовательный append под единственным worker writer; `manifest` обязан содержать счётчики `discovered`, `queued`, `fetched`, `skippedRobots`, `fetchErrors`, `failedSources`, `truncated`, `discoveryComplete`, `scanComplete`.

Скан прерывается — `checkpoint` позволяет продолжить без повторной полной выгрузки. Если фид API менялся, скан при resume может пометить `source_snapshot_changed/incomplete` вместо ложной сопоставимости.

Web UI получает постраничные результаты через read-only API, не читает и не сериализует целиком `findings.jsonl` в одной HTTP-операции. В первых релизах сгенерированный index по группам rules/severity/URL подходит. Для результатов 100k+ файловый индекс должен поддерживать seek/page. Файловая модель, а не скрытый SQLite.

Политика retention удаляет только завершённые незафиксированные запуски за пределами срока/количества, с защитой работающего скана.

## 10. Web REST API (локально защищённый)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/auth/login` | Вход; rate-limit, secure cookie |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/me` | Проверка сессии |
| GET | `/api/projects` | Проекты + последние результаты |
| POST | `/api/projects` | Создать с server-side validation |
| GET/PATCH | `/api/projects/:id` | Просмотр/изменение профиля |
| POST | `/api/projects/:id/validate` | Проверить конфигурацию/доступность источников |
| POST | `/api/projects/:id/scans` | Поставить scan в очередь |
| GET | `/api/projects/:id/scans` | История запусков |
| GET | `/api/projects/:id/scans/:scanId` | Прогресс и manifest |
| POST | `/api/projects/:id/scans/:scanId/cancel` | Остановить |
| POST | `/api/projects/:id/scans/:scanId/resume` | Продолжить после interrupted/incomplete |
| GET | `/api/projects/:id/scans/:scanId/findings` | Фильтры + pagination |
| GET | `/api/projects/:id/scans/:scanId/findings/:findingId` | Доказательства |
| GET | `/api/projects/:id/scans/:scanId/compare/:otherId` | Diff (только сравнимые scans) |
| GET | `/api/projects/:id/scans/:scanId/download/:kind` | Авторизованная выгрузка whitelist типов |
| GET | `/api/health` | Readiness/Liveness (минимальные безопасные сведения) |

Все write методы авторизованы и защищены CSRF; `GET` не изменяет состояние. UI не получает API credentials; клиент отправляет только безопасные настройки без секретов. Export пути нельзя строить из пользовательского имени файла (path traversal).

### UI страницы

1. Login / session timeout.
2. Dashboard с totals и графиком по проектам.
3. Project create/edit/validate: домен, источники, лимиты, URL policy.
4. Scan history/start/stop/progress.
5. Findings list + фильтры / bulk CSV.
6. Finding details + evidence / рекомендации / confidence.
7. Scan comparison + new/resolved/persisting/unknown.
8. System status, retention, диагностика сбоев.

UI обязан явно показывать `Scan incomplete` и перечень непроверенных источников. Экспорт доступен даже для incomplete, но имеет watermark `INCOMPLETE`.

## 11. Защита системы и эксплуатация

- Public crawler: только HTTP(S), hostname allowlist + проверка public resolved IP (IPv4/IPv6) и закрепление подключения за проверенным IP; **каждый redirect** валидируется заново. DNS rebinding защита обязательна. Никаких `file://`, metadata IP, localhost, Docker bridge, внутренних диапазонов, URL userinfo, redirects наружу.
- Backend API: отдельный allowlist (по умолчанию только public HTTPS); если требуется внутрисетевой endpoint, администратор должен явно включить доверенный network policy; ограничить Docker egress. Секреты из ENV/docker secrets.
- Таймауты + content-length/decompression size cap, защита от XML entity expansion; без исполнения JS из сканируемого сайта.
- Auth: single admin с `ADMIN_PASSWORD_HASH` Argon2id, защита brute force, server-side session files, HttpOnly Secure SameSite cookies, CSRF token, `Content-Security-Policy`, security headers, session rotation/logout. TLS через обязательный reverse proxy для любой нелокальной публикации.
- Reporting: HTML escape, запрет raw target HTML в DOM; CSV formula escape; запрет внешних ссылок download на файловые пути; sanitize URL credentials/query tokens/PII; no logs auth data.
- Docker: nonroot, explicit port binding to `127.0.0.1` по умолчанию, disk permissions, healthcheck, graceful shutdown, readonly image; volume `/data` для сохранения.
- One scan per project; global parallel limit (default 1-2 projects). Reject duplicate start with 409 + ссылка на currentScanId.
- Не обходить CAPTCHA/антибот и не выдавать UA-switch за реальный Googlebot. Если защита мешает диагностике — `blocked_or_challenged/needs_review`.

## 12. Планировщик

- Cron выражение хранится в project config (`scanSchedule` опционально) + timezone; scheduler только ставит scan, worker его выполняет.
- Идемпотентная постановка по `(projectId, scheduledAt)`; lock предотвращает двойной старт.
- При missed schedule после downtime: запускать не более одного catch-up, настройки configurable.
- Полный и быстрый режим: **оба** поддерживаются, но `full` обязателен и ни один `quick` не отображается как полный. Для первого релиза `quick` может использовать пользовательский список seeds; `full` — все источники.

## 13. Тестовые фикстуры, проверка без реального сайта

Fake-server должен воспроизводить:

- `GET /products/ok` -> 200 + Product JSON-LD valid, canonical, title.
- `GET /products/missing-rating-count` -> 200 + Product aggregateRating без count.
- `GET /products/backend-expected-missing` -> 404, backend feed expectedStatus=200.
- `GET /categories/unknown` -> 200 + fallback общего каталога, backend свидетельствует, что slug неизвестен.
- `GET /products/redirect` -> 308 -> `/products/ok` (валидный permanent redirect).
- `GET /products/loop1` -> 301 -> loop2 -> loop1.
- `GET /products/robots` blocked через robots.txt.
- `GET /broken-source` -> 200 + ссылка на `/dead-link` 404.
- `GET /indexable-noindex` -> 200 + noindex.
- `GET /duplicate-id` -> 200 + two elements id=`same`.
- `GET /java-only` -> 200 HTML shell with no product content: `SSR_CONTENT_MISSING/needs_review`, а не SEO P0.
- Sitemap index с двумя дочерними картами, общее число URL > 50k через fixture generator (не обязательно реальный большой XML-файл), циклические sitemap references.
- 429 Retry-After, 500 transient, timeout, gzip overflow, cross-domain and DNS rebinding redirects.
- API cursor pagination 2 pages, auth error, cursor loop, inconsistent snapshot.

## 14. Критерии приёмки: автоматизированные AC-01…AC-28

| ID | Сценарий и ожидаемый результат |
|---|---|
| AC-01 | `docker compose up -d` поднимает UI+worker без БД; health ok, volume writable |
| AC-02 | Новая установка недоступна без admin login; GET reports без сессии -> 401 |
| AC-03 | Через UI создаётся проект, валидация показывает ошибки URL/hostname и сохраняет валидный профиль |
| AC-04 | Один и тот же binary сканирует два разных сайта без изменения кода/доменных констант |
| AC-05 | XML sitemap index и два дочерних sitemap обрабатываются, источники URL сохраняются |
| AC-06 | Full scan обходит все feed+sitemap+HTML links в пределах явно заданной политики, без тихого отсечения |
| AC-07 | При maxUrls превышении status=incomplete, и UI явно показывает причину/coverage |
| AC-08 | Cursor pagination backend не теряет сущности; при 401/timeout error source, не SEO 404 |
| AC-09 | Entity `published/expected200`, HTTP404 -> EXPECTED_PAGE_NOT_200 с entityId и доказательством |
| AC-10 | Entity `deleted` и HTTP404 без expected200 -> без ложного P0 |
| AC-11 | `trailingSlash=unknown`, 308 со слеша на без слеша -> нет ошибки о неправильном слеше |
| AC-12 | `canonical` конфликтующий с явно заданной policy -> CANONICAL_CONFLICT; корректный -> pass |
| AC-13 | Product aggregateRating без ratingCount/reviewCount -> PRODUCT_RATING_COUNT_MISSING |
| AC-14 | Product без aggregateRating -> нет ошибки рейтинга |
| AC-15 | Битая внутренняя `<a href>` создаёт BROKEN_INTERNAL_LINK с sourcePage |
| AC-16 | JS button без href -> максимум NEEDS_REVIEW, не фальшивый broken link |
| AC-17 | robots disallow -> skipped_robots, ни 404 ни доказанный noindex |
| AC-18 | 200 shell без JS данных -> needs_review, не заявлять доказанный 404/бан |
| AC-19 | 301/308 redirect chain сохранена; redirect loop выявлен без бесконечной загрузки |
| AC-20 | 429 Retry-After соблюдён, лимиты request concurrency и timeout применяются |
| AC-21 | Запрос/redirect к localhost, private IP, metadata IP и forbidden host блокируется до подключения |
| AC-22 | DNS rebinding / second lookup не позволяет обойти разрешённый IP, TLS проверяется |
| AC-23 | При kill worker и restart progress восстановлен; скан не становится completed раньше времени |
| AC-24 | Второй scan того же проекта отклонён 409/возвращён current id; locks очищаются безопасно |
| AC-25 | CSV с `=HYPERLINK(...)` экранирован; HTML с `<script>` отображается текстом, не исполняется |
| AC-26 | CSV/JSON/HTML скачиваются только после авторизации, ошибки/секреты не утекли |
| AC-27 | Diff показывает new/resolved/persisting; incomplete второй запуск даёт unknown вместо resolved |
| AC-28 | Все обязательные отчёты созданы, totals совпадают с числом строк, UI pagination работает на большом fixture |

Для каждой AC должен быть test case с мок-HTTP или disposable fixture-site, не зависеть от доступности публичного сайта и внешних API.

## 15. Условия готовности к эксплуатации

- CI: TypeScript check, eslint, unit tests, integration fixture tests, Playwright UI e2e (только собственного UI), Docker smoke.
- OpenAPI или формальная JSON Schema для UI API, Entity Feed и каждого сохраняемого файла; версия контрактов.
- Документация: README с настройкой HTTPS reverse proxy и Docker, `.env.example`, config schema, feed contract, пример import, backup, resume, security.
- Контрольная проверка SABOSPORTS лишь **после согласия владельца на сканирование** и установки мягких rate limits.
- Проблемы внешнего вебмастера не разрешаются автоматически; доказательства из GSC/Яндекс.Webmaster — только после отдельной интеграции V2.

## 16. Не использовать как требования MVP

- «Сайт индексируется Google/Яндекс» по результату HTTP 200.
- «Бот точно получает 404» по ответу поддельного User-Agent.
- Автоматическое добавление `/` в конце любого URL.
- Редирект всех старых 404 на главную.
- Удаление AggregateRating всегда, даже если есть реальные оценки.
- Обязательное наличие H1 ровно в одном экземпляре.
- Считать `alt=""` дефектом для любой картинки.
- Фиктивные оценочные баллы Lighthouse без запуска браузера.

## 17. Sources / external standards

- Google canonical: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google links: https://developers.google.com/search/docs/crawling-indexing/links-crawlable
- Google sitemap: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
- Google Review/Rating: https://developers.google.com/search/docs/appearance/structured-data/review-snippet
- OWASP SSRF: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- GSC URL inspection (V2): https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect