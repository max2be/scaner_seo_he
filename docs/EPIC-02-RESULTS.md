# EPIC-02 — результат

## Объём
Реализованы E02-01…E02-05: библиотека SafeHttpClient, безопасность транспорта,
redirects, request controls, robots и HTTP/TLS integration fixtures.
Никакой привязки к сайту или CMS, браузерного сканирования, БД и внешнего APM.
Discovery, backend Bearer feed, scan lifecycle и UI entry остаются следующим этапам.
Блокирующих противоречий PRD и ТЗ для этой реализации не обнаружено;
консервативная robots/error политика явно описана в ADR-006/007.

## Проверка acceptance criteria

| AC | Проверка | Результат |
|---|---|---|
| AC-17 | robots deny → skipped_robots; page body не запрашивается, нет выдуманного 404/noindex | pass |
| AC-19 | 301/308 chain, relative Location, loop/max hops, запрет небезопасных переходов | pass |
| AC-20 | 429 Retry-After numeric/date, host-wide pause, concurrency/rate, absolute timeout | pass |
| AC-21 | URL/host gate; private/loopback/link-local/metadata IPv4/IPv6; mixed DNS; redirect SSRF до connect | pass |
| AC-22 | Числовой IP pin, отсутствие второго DNS lookup, повторная DNS-проверка redirect, peer mismatch, TLS trust/name/SNI | pass |

Проверки выполнены с локальными HTTP/TLS fixtures. Тестовый adapter подменяет
**только в тестах** выбранный public IP адресом disposable loopback server;
production API не предоставляет allow-private режим. Это не аудит внешнего
сайта и не проверка доступности реальных production destinations.

## Выполненные команды

- `npm ci --ignore-scripts` — pass, установка по обновлённому lockfile.
- `npm run check` — pass: lint, typecheck (включая UI/tests), Vitest, build.
- **132 tests passed, 5 test files; 0 failed/skipped.** Из них 88 новых HTTP/security
  тестов и 44 regression теста EPIC-01.
- `npm run smoke` — pass, web/worker health200, private API401, SIGTERM exit0.
- `npm audit --omit=dev` — 0 известных уязвимостей на момент проверки.
- `node scripts/cloud-docker-build.mjs` — pass, TLS/checksum verification включены.
- Docker Compose — оба сервиса healthy; production image импортирует @hsi/core,
  блокирует private destination до соединения и работает non-root. Web health — 200.
- `git diff --check` — pass. Проверенные skill hashes не изменились.

Удалённый GitHub Actions run не запускался. Нагрузочный прогон 100k URL,
пилотный сайт и arm64 в эту проверку не входили.

## Контракты и данные

Новые additive schemas: HttpAttemptSchema/HttpFetchResultSchema; ранее сохраняемые
форматы и ограничения v1 не изменены, миграция старых файлов не требуется.
Доказательства включают попытки и robotsAttempts отдельно. Тело ответа временное,
non-enumerable; query values маскируются; raw cookies/auth/errors и HTML excerpts
не сохраняются. Severity клиент не назначает. Подтверждение 404/410 — только
explicit confirmExpectedMissing и с сохранением обеих попыток.

## Созданные файлы

- `packages/contracts/src/http.ts`
- `packages/core/src/http/client.ts`
- `packages/core/src/http/errors.ts`
- `packages/core/src/http/policy.ts`
- `packages/core/src/http/scheduler.ts`
- `packages/core/src/http/transport.ts`
- `tests/http-fixture.ts`
- `tests/http-client.test.ts`
- `tests/http-policy.test.ts`
- `tests/http-robots.test.ts`
- `tests/fixtures/tls/fixture.crt`
- `tests/fixtures/tls/fixture.key` — синтетический тестовый ключ, не deployment secret
- `tests/fixtures/tls/README.md`
- `docs/http-client.md`
- `docs/EPIC-02-RESULTS.md`

## Обновлённые файлы

- `packages/contracts/src/index.ts`, `packages/core/src/index.ts` — public exports.
- `packages/core/package.json`, `package-lock.json` — ipaddr.js и robots-parser.
- `AGENTS.md`, `.ai-factory/PLAN.md`, `.ai-factory/skill-context/aif-plan/SKILL.md` — scope текущей итерации.
- `docs/DECISIONS.md`, `docs/development.md`, `README.md` — решения и использование.
- start_skill в черновике среды — актуальные возможности, ограничения и команды.

## Далее: EPIC-03

Подключить библиотеку к sitemap index/gzip/XML streaming и HTML link discovery,
Entity Feed cursor pagination с отдельным backend allowlist/auth scope. Не передавать
Bearer при переходе на другой origin, не превращать source_error в SEO finding.
Сохранять provenance; явно различать full/incomplete. Перед enqueue каждую найденную
цель проверять политикой; не заменять SafeHttpClient обычным fetch.
Нагрузка 10k–100k требует bounded producer/consumer; не запускать 100k promises
одновременно и не создавать отдельный client на каждый URL.
