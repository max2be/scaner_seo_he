# Discovery — EPIC-03

## Запуск

Node.js 24, npm workspaces; из корня checkout:

```bash
npm ci --ignore-scripts
npm run build
npm run discover -- --project /path/to/project.json --output /path/to/private-output
```

Запускайте только на сайте, проверку которого вы уполномочены выполнять. Обе сети —
public site и backend — проходят numeric IP pinning/TLS. Native transport не использует
outbound proxy; доступность production destinations в облаке не проверялась.
CLI возвращает JSON summary + созданный каталог, exit 0 = complete, 2 = incomplete,
1 = ошибка конфигурации/диска/запуска. Значения секретов и ошибки с raw input не печатаются.
SIGINT/SIGTERM отменяют операции; незавершённый discovery не выдаётся за complete.

UI и worker health service пока не ставят discovery в постоянную очередь. CLI — отдельный
composition root. Сохраняемые данные требуют приватного каталога; публичная раздача запрещена.

## Программный интерфейс

```ts
import { discover } from '@hsi/sources';
import { FileDiscoveryStore, FileResponseSpool } from '@hsi/storage';

const store = await FileDiscoveryStore.create(privateParent);
try {
  const summary = await discover(project, {
    store,
    createSpool: () => FileResponseSpool.create(store.directory),
    signal: controller.signal,
    onPage: (record, result) => store.recordPage(record, result),
  });
} finally {
  await store.close();
}
```

Один store и один SafeHttpClient на запуск. Не выполнять несколько discover на одном store.
DI клиентов в options нужен для тестов/композиции, не является JSON-настройкой обхода SSRF.
Sitemap/feed импортируются по очереди, затем BFS. Бounded concurrency HTTP-клиента сохраняется;
в этой реализации orchestration последовательная, без 100k promises и без каталога в Map.

## Источники и политика

- **Sitemap:** index и urlset, namespaces и UTF-8, XML entities только стандартные;
  DTD/external entities/неподдерживаемые encoding запрещены. SOAP/HTML вместо sitemap — source_error.
  Shared child карты не являются циклом, ancestor cycle — ошибка источника.
- HTTP поток пишет приватный временный файл с backpressure; SAX разбирает файл порциями.
  Нативный HTTP decoder обрабатывает Content-Encoding; gzip файла определяется по magic.
  50 000 entries / 50 000 000 decoded XML bytes **на отдельный файл**, не на весь проект.
  HTTP maxResponseBytes остаётся дополнительным guardrail (по примеру 5MB); при его
  достижении источник неполон. Для больших допустимых карт настройте его явно до 50MB.
- Ограничены XML depth (64) и lexical token size (64KiB), loc length (8192), index depth (32),
  sitemap count (10000), feed pages (10000), feed entities (1000000). Операционные source
  caps можно уточнить через typed limits options; достижение всегда visible incomplete.
- **Entity Feed:** нормативный cursor/nextCursor v1, bounded page JSON через Zod.
  Page-based чужой API требует адаптера, а не нового неописанного поля конфигурации.
  Нет snapshotId на всех страницах → consistency unknown; изменение/удаление ID,
  повтор cursor или entity identity, неверная JSON/schema, 401/403, timeout → source_error.
  Частичные сущности сохраняют факты, но не доказывают полноту/отсутствие других сущностей.
- Backend endpoint обязан быть HTTPS и в backend.allowedHosts. Отдельный клиент читает
  tokenEnv на runtime; Bearer идёт только на **исходный origin**. Междоменный или межпортовый
  redirect блокируется до передачи токена даже если hostname есть в allowlist. Robots
  публичного сайта к read-only backend API не применяется. Feed credentials в UI не поступают.
- **HTML:** source HTML, без браузера/JS/assets. Tokenizer читает chunks без DOM и без общего
  массива всех ссылок. Первый base применяется ко всем anchors; URL разрешаются относительно
  конечного ответа. Проверяются также ссылки в HTML 404; 401/403/429/5xx являются
  недоступным источником ссылок и делают discovery incomplete.
- Query allowlist сохраняет разрешённые keys, tracking patterns с конечным `*` удаляются;
  неизвестные query keys исключают URL целиком, не превращают facet в другой адрес.
  mode=drop — явное удаление всех query. with/without нормализуют slash только по конфигу;
  unknown/preserve сохраняют различие `/a` и `/a/`. Фрагменты не порождают запросов.
- Консервативный default: nofollow не расширяется; внешние домены, pseudo-URLs, fragment-only
  и неподходящие query считаются scope exclusions. Они учтены в excluded. URL, присутствующий
  в другом разрешённом источнике, всё равно обрабатывается.

## Данные

Каждый запуск получает **новый** приватный подкаталог, существующие файлы не перезаписываются:

- `urls/<hash-prefix>/<sha256>.json` — уникальный URL, минимальная глубина, sourceSet.
- `queue.jsonl` — quoted SHA-256 по фиксированным 67 байт, чтение по offset без полного массива.
- `provenance/<prefix>/<hash>.jsonl` — все принятые source edges, sourceUrl/href/entity, без
  громадного массива backlinks/entityRefs внутри одного URL record. Dedupe не теряет источники.
- `markers-*` — дисковые seen sets для map/cursor/entity; ключи хешированы, не пути из input.
- `pages.jsonl` — CLI callback записывает typed HTTP metadata без body. Ранний sourceSet здесь
  является snapshot на момент fetch; финальный sourceSet читается из URL record, связи — provenance.
- `issues.jsonl`, `summary.json` — ошибки, caps и полнота. Повторы одной limit reason агрегируются;
  excluded считает все исключённые попытки. HTTP 404 сам по себе не ошибка discovery или P0.

Query values в evidence/sourceUrl/href маскируются, фрагменты удаляются. Нормализованные URLs
в приватном spool нужны для реального fetch. Entity содержит только поля v1; провайдер не
должен помещать credentials/PII в эти структурные данные. Полный HTML/feed JSON не сохраняется.
Временные sitemap файлы удаляются при завершении и ошибке; отменённый stream очищается
до возврата результата. После аварийного kill могут остаться приватные временные файлы.

Новые DiscoveryRecord/Provenance/Issue/Summary schemas additive; старые v1 persisted contracts
не изменены. Spool **не реализует** durable scan lifecycle/resume, межпроцессные locks, leases,
checkpoint/fsync policy или retention; это EPIC-04. Сам файл на диске не доказывает recoverability.

## Полнота

Complete означает: все настроенные источники закончены, все допущенные URLs обработаны,
не осталось ошибок/сработавших caps. MaxUrls и maxDepth с новыми eligible URLs дают incomplete;
достигнутое число без потерянных новых URL не объявляется truncated автоматически.
Empty discovery помечается incomplete/no_urls_discovered. При сбое feed независимые проверки
сайта продолжаются. Флаги sitemapComplete/backendComplete и snapshotConsistency не подменяют
SEO verdict. Для scan lifecycle итог discovery должен быть явно преобразован в manifest EPIC-04.

## Проверки

Локальные HTTP/TLS fixtures, отдельная синтетическая пара сертификат/ключ, никаких production
сканов. Parser test обрабатывает 60 000 entries из двух карт и отвергает 50 001 в одной;
это проверка per-file scope, не benchmark file-only индекса на 100k URL (EPIC-10).

EPIC-04 добавляет отдельный DurableDiscoveryStore и `npm run scan`;
подробности в [durable-storage.md](durable-storage.md). Ограничения ephemeral spool выше
сохраняются для прежнего `npm run discover`; production worker использует новый протокол.
