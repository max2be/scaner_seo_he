# Безопасный HTTP-клиент — EPIC-02

## Использование

```ts
import { SafeHttpClient } from '@hsi/core';
import { ProjectConfigSchema } from '@hsi/contracts';

const project = ProjectConfigSchema.parse(input);
const client = new SafeHttpClient(project); // один экземпляр на проект/запуск
const result = await client.fetch(url, { signal: abortController.signal });
if (result.status === 'fetched') {
  // Временный Buffer для будущего парсера; не сохранять полный HTML.
  const html = result.body.toString('utf8');
  const evidence = result.evidence;
}
```

Клиент не реализует discovery, очередь сканов, SEO-классификацию, API/UI и backend Bearer.
Фид backend будет иметь отдельный allowlist и ограничение передачи auth на EPIC-03;
не использовать публичный клиент как shortcut для секретов backend.

## Гарантии транспорта

- Только GET/HTTP(S), точное совпадение hostname allowlist, без URL userinfo,
  control characters и известных credential query keys. Никаких авто-redirect/cookies.
- Все возвращённые DNS A/AAAA должны быть public unicast; mixed/private ответ отклоняется.
- Новый socket на проверенный **числовой IP**, поэтому между проверкой DNS и connect
  нет повторного lookup hostname. Сверяется remoteAddress, включая IPv4-mapped socket peer.
- Для HTTPS остаются исходные Host/SNI и проверка сертификата по исходному имени;
  rejectUnauthorized=true. Нет настройки отключения TLS в ProjectConfig.
- Каждый redirect снова проходит allowlist, DNS/IP, robots, loop/hop проверки;
  HTTPS→HTTP запрещён. Небезопасный Location не копируется в evidence.
- Нативный транспорт не использует env proxy. Прокси может резолвить DNS иначе,
  поэтому не считается допустимой заменой connection-bound pinning.
  В среде с обязательным outbound proxy этот транспорт может вернуть сетевую ошибку;
  это не повод отключать IP/TLS проверки. Внешняя связность здесь не проверялась.

## Лимиты и повторы

- Один общий semaphore на клиент; каждый hostname имеет интервал начала запросов.
  Положительная скорость до 100 req/s/host как в контракте v1; значения, дающие
  непредставимый числом интервал, отклоняются до сетевых запросов. Длинные ожидания
  разбиваются на допустимые для Node timer интервалы. Не создавать отдельный клиент на каждый URL, иначе rate budget раздробится.
- `timeoutMs` ограничивает DNS+connection+headers+body одной попытки. Дополнительно
  есть socket idle timeout. Ожидание rate-limit/retry не входит в timeout одной попытки;
  для общего бюджета использовать AbortSignal. Ожидающие и активные задачи отменяемы.
- Ограничены encoded wire bytes, decoded bytes и headers (16 KiB). gzip/deflate/br
  распаковываются потоково. Лимит decoded тела — maxResponseBytes, не только Content-Length.
- 429/500/502/503/504: не более min(maxRetries,2) повторов, backoff 250/500ms + jitter.
  Retry-After numeric/date — нижняя граница ожидания и задержка остальных запросов хоста.
  Значение >60s: без раннего повтора; host circuit сохраняет указанное ограничение,
  вызов с запланированным retry возвращает retry_after_exceeds_budget.
- Пять последовательных transient/network/timeout failures открывают circuit на 60s.
  Новые запросы возвращают circuit_open; уже начатые могут завершиться. Продолжать
  скан как completed при этом нельзя — lifecycle обработает EPIC-04.
- Обычный 404 не повторяется. `confirmExpectedMissing: true` разрешает одно подтверждение
  404/410; использовать только для ожидаемой опубликованной страницы, кандидата P0.
  Обе попытки сохраняются, severity клиент не назначает.

## Robots

По умолчанию берётся respectRobots из проекта (пример: true). Один deduplicated load
на origin с cache TTL 1h; собственный robots GET не проверяет себя рекурсивно, но
обязательно проходит сетевую защиту, rate/retry и body limit до min(512000,maxResponseBytes).
Правила применяются к настроенному User-Agent, поддерживаются groups, Allow/Disallow,
wildcards и end anchor через robots-parser. Crawl-delay не является RFC9309-обязательным
правилом; скорость задаёт конфигурация проекта.

| Ответ robots | Действие |
|---|---|
| 2xx text | Разобрать правила; пустой файл разрешает |
| 404/410 | Правила отсутствуют, разрешить |
| 401/403 | Консервативный deny: skipped_robots |
| Иные ошибки, timeout, oversized, HTML challenge | fetch_error/robots_unavailable |

Это более консервативная политика, чем разрешение по всем 4xx. `skipped_robots` не
содержит выдуманного HTTP-статуса страницы и ничего не говорит об индексе поисковика.
Robots учитывается также для redirect destination. При ошибке cache entry удаляется.

## Контракты и приватность

`HttpFetchResultSchema` и `HttpAttemptSchema` — новые additive runtime schemas
для временного результата клиента. Форматы и ограничения ранее сохраняемых v1 файлов не изменены. Discovery и storage
не должны сериализовать HttpFetchResult как UrlRecord без явного преобразования.

- `fetched`: конечный HTTP evidence, attempts и redirectChain. 404/5xx — реальные
  HTTP ответы, а не автоматически SEO находки.
- `skipped_robots`: reason и robotsAttempts, без page evidence/body.
- `fetch_error`: безопасный код, успешные/неуспешные attempts и завершённые safe hops.
  Для опасного исходного URL requestedUrl вообще не копируется.
- `robotsAttempts` сохраняет фактические запросы robots отдельно, в том числе из cache,
  с timestamp/status/error/hash. Тело robots и headers в metadata не записываются.
- Все query values в evidence URL маскируются. Заголовки Authorization/Set-Cookie и
  raw errors не возвращаются. Body — non-enumerable Buffer: JSON.stringify(result)
  по умолчанию не экспортирует HTML. htmlExtract не заполняется до отдельного sanitizer.
- Редактирование произвольного PII в URL paths и фрагментах HTML — отдельная задача
  reports/rules; не добавлять raw HTML в persisted records.

## Проверки без production-сайтов

Тесты выполняют реальный HTTP/TLS к loopback fixtures. Только тестовый adapter
заменяет уже проверенный public pin адресом fixture. В конфигурации/production
нет allow-private режима. Отдельно тестируются запрет private DNS **до** транспорта,
отсутствие повторного native DNS lookup, remote peer mismatch, TLS hostname/SNI/trust,
rebinding при redirect, gzip bomb, таймауты, rate/retry/circuit и robots.
Синтетические `tests/fixtures/tls/fixture.key/.crt` — исключительно тестовые данные,
не production credentials. CA передаётся только внутреннему fixture transport.
