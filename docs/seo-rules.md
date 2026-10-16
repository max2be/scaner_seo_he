# Rule Engine и SEO facts — EPIC-05

Реализованы E05-01…07, FR-04, AC-09…18. Это анализ исходного HTTP/HTML; нет исполнения
JavaScript, сведений о реальном индексе поисковых систем или гарантий rich results.
PRD/ТЗ/backlog/examples не меняются. Архитектурные решения: ADR-012/013.

## Запуск и конфигурация

```sh
npm run build
npm run scan -- --action start --project /private/project.json --rules /private/rules.json --data /private/data --scan-id audit-001
```

`--rules` необязателен: новый scan получает стандартный профиль. Он фиксируется в
`scans/SCAN/rules.json` отдельно от неизменного ProjectConfig v1.0. Например:

```json
{
  "schemaVersion": "1.0",
  "severityOverrides": {"DESCRIPTION_MISSING": "INFO"},
  "maxRedirectHops": 2,
  "checkTrailingSlash": true,
  "unknownRouteProbes": []
}
```

Для явной проверки заранее известного отсутствующего URL можно добавить:

```json
{"url":"https://shop.example.com/known-absent-control","notFoundMarker":"KNOWN_MISSING_ENTITY"}
```

Это элемент `unknownRouteProbes`, не новый endpoint backend. Оператор обязан знать,
что URL — контрольный отсутствующий ресурс, а marker — достоверный признак отсутствия.
Без совпавшего marker HTTP200 даёт только needs_review. Произвольные slug не генерируются.
Probe должен точно сохраняться после project URL normalization и быть внутри allowlist;
неподдерживаемые query/fragment/host отклоняются до сети. Профиль не содержит secrets.

Overrides меняют severity, сохраняя факты. Неизвестный rule ID — ошибка конфигурации.
P0 разрешён только для доказанных EXPECTED_PAGE_NOT_200/NOINDEX_EXPECTED_PAGE;
для остальных правил и needs_review запрос severity=P0 ограничивается P1.
Новый профиль/повторное наблюдение требует нового scan ID, а не изменения frozen scan.

## Pipeline и восстановление

1. Discovery собирает sitemap/feed/seed/control URLs и links, сохраняя финальную provenance.
2. Worker запрашивает HTML безопасным SafeHttpClient. Для ожидаемого indexable ресурса
   404/410 подтверждается одним дополнительным GET. Обе попытки остаются в HTTP metadata.
3. До URL checkpoint сохраняются HTML facts и до двух диагностических checks:
   одна однозначная разрешённая canonical-цель и альтернативная форма слеша.
4. После discovery отдельный проход по disk queue анализирует финальные URL records,
   facts, source edges и entity refs. Это учитывает sourcePage, найденный после target GET.
5. Findings и analysis errors записываются в тот же WAL. Analysis checkpoint после каждого
   URL позволяет продолжить анализ без повторного HTTP обхода.

Все диагностические GET используют тот же сайт-клиент и его SSRF/DNS pinning/TLS,
allowlist, robots, concurrency, rate/retry/circuit guards. Внешние canonical без allowlist
не запрашиваются. Диагностика не запускает рекурсивный обход canonical-целей. Известный
ответ может переиспользоваться; число проверок на страницу ограничено двумя. Они видны
в PageObservation.checks; manifest.discovered/queued/fetched считает основной discovery,
а не дополнительные GET. Это добавляет нагрузку; checkTrailingSlash можно отключить.
При unknown/preserve ответы обеих форм сохраняются без навязывания правильного слеша.

Временные Buffer HTML не сериализуются. На диск попадают schema-validated структурные
facts, title hash, allowlisted Product/Offer данные, безопасные числовые JSON fragments,
applicable noindex/nofollow и HTTP metadata. Set-Cookie/Authorization/посторонние response
headers не сохраняются. X-Robots-Tag передаётся парсеру transient и преобразуется в факты.
Final URL query identity сравнивается по hash: redacted metadata не создаёт ложный
self-canonical conflict. Title/description/body prose и произвольный JSON-LD не сохраняются.
URLs, SKU, entity IDs и курсоры остаются приватными бизнес-данными DATA_DIR/архивов.

## Поддержанные правила

| Группа | Rule IDs | Условия / исключения |
|---|---|---|
| Ожидаемый HTTP | EXPECTED_PAGE_NOT_200, HTTP_SERVER_ERROR | Published expected-indexable entity и сопоставимый завершённый feed; 5xx максимум P1 без доказанного масштаба |
| Redirect | REDIRECT_LOOP, REDIRECT_CHAIN_LONG | Наблюдаемый loop/число hops, не догадка о причине CDN |
| Soft404/control | UNKNOWN_ROUTE_RETURNS_200, SOFT_404_SUSPECTED | Explicit marker даёт finding; одна фраза/200 — needs_review |
| Canonical | CANONICAL_MISSING, CANONICAL_CONFLICT, CANONICAL_TARGET_BROKEN | Абсолютный URL, конфликтующие tags, scheme/host/slash/self/entity policy; нет универсального требования self-canonical |
| Slash | TRAILING_SLASH_CONFLICT | Только явные with/without; оба 200 или неверное направление redirect; unknown/preserve не дефект |
| Sitemap | SITEMAP_URL_NOT_INDEXABLE, EXPECTED_URL_MISSING_FROM_SITEMAP | Missing требует завершённых карт и complete feed; unknown snapshot даёт review; noindex/404/5xx/наблюдаемый redirect conflict — факты |
| Links | BROKEN_INTERNAL_LINK, ANCHOR_HREF_MISSING | HTTP404/410 + обязательный sourcePage; anchor без href — INFO/needs_review, может быть намеренным |
| Robots | ROBOTS_DISALLOWED_EXPECTED, NOINDEX_EXPECTED_PAGE | Disallow для нашего UA не равен noindex и не доказывает 404/состояние Google |
| Metadata | TITLE_MISSING, DESCRIPTION_MISSING, H1_MISSING, DUPLICATE_TITLE | На indexable HTML; несколько H1 допустимы; truncated parser не создаёт missing-field findings |
| JSON-LD | JSONLD_PARSE_ERROR, PRODUCT_RATING_COUNT_MISSING, PRODUCT_RATING_COUNT_INVALID | Product AggregateRating: count/reviewCount должны быть положительными целыми; отсутствие самого rating не дефект |
| Backend compare | PRODUCT_DATA_CONFLICT | Product/Offer price/currency/availability при сопоставимых identity/SKU и завершённом snapshot; неоднозначные variants — needs_review |
| Source quality | DUPLICATE_DOM_ID, DUPLICATE_MANIFEST, IMAGE_ALT_MISSING, IMAGE_DIMENSIONS_MISSING | P2/INFO; пустой decorative alt допустим; не оценка browser layout/CLS |
| JS/SSR hints | BUTTON_NAV_SUSPECTED, SSR_CONTENT_MISSING | Только needs_review; JS не исполняется, shell не объявляется доказанным soft404/баном |
| Type | RESPONSE_CONTENT_TYPE_INVALID | Ожидали HTML landing, получили иной тип; известные media/assets исключены |

Registry содержит 31 правило версии 1.0.0. Для каждого есть positive/negative tests.
Default CANONICAL_MISSING при checkSelfCanonical=false — INFO; остальные defaults
задаются registry. P0 HTTP требует expectedStatus=200 (или default200), published,
explicit expectedIndexable=true, backendComplete=true, snapshotConsistency=consistent,
двух согласованных конечных GET404/410. Deleted/unpublished/unknown entity не подходит.
Без snapshot невозможно доказать сопоставимость: наблюдённое расхождение entity/HTTP/Offer
остаётся needs_review с максимум P1, даже если HTTP404 повторился. Правила не скрывают
известный факт, но не повышают его до доказанного P0.
Сбой/неполнота feed не создаёт SEO404. Generic HTTP/HTML факты анализируются независимо.

Applicable meta robots — `robots` или имя нашего user agent. X-Robots scoped для чужого
робота не применяется к нашему профилю. Noindex положительный факт, а robots disallow
лишь ограничивает получение. Для noindex/nonindexable страниц canonical/missing metadata
не навязываются. Seed/control 200 не становится P0 из-за исторического сообщения поисковика.

Duplicate titles используют SHA256 нормализованного title и файловые buckets/markers.
Нет каталожного Map/массивов в памяти. Группа имеет стабильный lexicographic anchor URL;
redirect aliases, non-self canonical copies, known nonindexable entities и control probes
не входят в группу. Если группа меняется, anchor может измениться; diff — EPIC-06.
Broken link finding агрегируется по target; sourcePage — один наблюдённый источник,
полный набор входящих source edges остаётся в provenance без огромного массива в finding.
firstSeenAt/lastSeenAt здесь относятся к наблюдению текущего scan; объединение истории — EPIC-06.

## Файлы, версии, migration

Новый scan: checkpoint/WAL **1.1**, `rules.json` v1.0; существующие ProjectConfig,
Finding, ScanManifest и Discovery schemas v1.0 неизменны. Новые ops observation/finding/
analysis_error/analysis_summary имеют schemaVersion1.1, прежние WAL ops читаются без изменений.
Checkpoint1.1 добавляет analysis.phase/offset/counters с checksum и runtime проверками.

- `derived/observations/<bucket>/<hash>.json`: ограниченные facts/HTTP/checks.
- `derived/titles/...`: маленькие групповые buckets, без полного каталога в JSON.
- `findings.jsonl`: Finding v1.0, id = SHA256(projectId, ruleId, normalized URL, entity type/id).
- `analysis_errors.jsonl`: отдельные typed ошибки parser/fetch/rule execution, не SEO findings.
- `analysis-summary.json`: urlsAnalyzed/rulesEvaluated/findings/needsReview/errors/coverageComplete.

findings/analysis_errors — hardlink views на derived файлы, перестраиваемые из WAL.
Незакоммиченный хвост не является результатом; сначала проверяйте manifest/checkpoint.
Missing facts/unsupported encoding/parser limit/diagnostic failure → incomplete analysis,
при этом manifest.discoveryComplete сохраняет самостоятельную правду о discovery.
Наличие находок само по себе не делает скан failed/incomplete. Needs_review — завершённая
проверка с оговоркой, а не доказанный дефект и не пропущенный URL.

Migration additive: новый запуск получает 1.1, reader поддерживает 1.0. Legacy scan не
получает rules/findings/analysis-summary автоматически, не реанализируется без HTML facts
и не объявляется SEO-проверенным. Для SEO нужен новый scan ID. Regression fixture
`tests/fixtures/storage-v1` содержит подтверждённый URL/HTTP200/summary/checkpoint1.0;
тест проверяет сохранение версии/данных без сетевых запросов. У legacy scanComplete
исторический смысл — полнота discovery, не наличие нового Rule Engine.

## Операционные пределы

На страницу: 16 canonical tags, 20000 DOM IDs, title до8192 символов, JSON-LD script до256000
символов/64 scripts, traversal до10000 nodes/depth32, до100 Products/100 offers на Product.
Превышение явно помечает facts.truncated и analysis error, не выдаёт частичный разбор за pass.
HTTP response cap остаётся в ProjectConfig. HTML декодируется по HTTP charset (Node TextDecoder,
fatal), по умолчанию UTF8; unsupported charset/invalid bytes — incomplete analysis.
Автоматическое определение charset по meta/эвристикам не реализовано. DTD/JS/внешние
JSON-LD contexts не загружаются. Никаких untrusted regexp из профиля.

Проверки Product/Offer/AggregateRating целевые; это не полный валидатор schema.org/Google.
100k benchmark, итоговые report indexes/CSV/HTML/diff, расписание, authenticated API/UI
относятся к последующим этапам. Production targets и ответ реального поискового робота
в этой итерации не проверялись.
