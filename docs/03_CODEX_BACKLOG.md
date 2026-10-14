# Headless SEO Inspector — Implementation Backlog for Codex

**Версия:** 1.0 · **Зависимости:** `01_PRD.md`, `02_TECH_SPEC_FOR_CODEX.md` · **Цель:** строить продукт инкрементально, без «всё в одном промпте».

## Обязательные инструкции для Codex

1. Прочитай PRD и спецификацию **до** написания кода. Создай отдельный `DECISIONS.md`, куда заноси подтверждённые решения и неразрешённые вопросы.
2. Работай по очереди EPIC-01…10. В одной ветке/итерации — одна небольшая законченная задача с тестами и изменённой документацией.
3. Не добавляй БД, Redis, браузерный crawler, GSC API или код CMS без отдельного approval — это вне MVP.
4. Все правила сайта (домены, слеш, sitemap, canonical, query) в конфигурации. **Никакого sabosports.ru в бизнес-логике.**
5. Ни одна важная функциональность не должна выдавать guessed-высказывания за факты: `needs_review` предпочтительнее ложного P0.
6. Для каждого API/хранимой сущности — типизированный контракт и runtime schema validation.
7. Никаких несекретных fallback значений для auth tokens. Логи и артефакты не содержат credentials/cookies.
8. В конце каждой задачи предоставь: изменённые файлы, что проверено, какие тесты выполнены, какие ограничения остались. Не заявляй «всё готово» без прохождения acceptance tests.
9. Если контракт в PRD противоречит спецификации, остановись и предложи вариант решения; не выбирай молча.

## Архитектурные ворота (до кодирования функций)

- Согласовать структуру monorepo, границы пакетов, TS types/Zod, соглашение Rule API, schemaVersion.
- Проверить угрозы SSRF и выбранного HTTP-клиента: невозможно реализовать безопасную pinning/redirect policy — **не разрешать произвольные домены**, отложить публичный deployment.
- Подтвердить сценарий масштабирования file-only индекса по 100k URL; нет «запишем всё в один JSON и распарсим в UI».
- Подтвердить, что UI будет auth-protected и все загрузки результатов через private API.

## EPIC-01. Скелет и Contracts (M0)

**Результат:** запускаются веб-сервис и worker; корректная структура репозитория, сборка, lint, tests, Docker Compose, конфиг схемы.

- E01-01 Monorepo packages `contracts/core/sources/storage/reports`, web/worker/ui; TypeScript shared config.
- E01-02 Zod `ProjectConfig`, `EntityFeed`, `ScanManifest`, `UrlRecord`, `Finding`, schemaVersion + unit validation.
- E01-03 Docker multi-stage build, compose, `/data` volume, `.env.example`, non-root, healthcheck.
- E01-04 CI lint/typecheck/unit smoke. Создать `docs/decisions.md`.

**Acceptance:** AC-01, AC-04 (минимум проекты через fixture без нового кода).

## EPIC-02. Безопасный HTTP fetcher (M1)

**Результат:** requests строго внутри allowlist с доказательствами, HTTP state, robots, redirects, timeout, retry.

- E02-01 URL validation + DNS/IP policy + connection-bound SSRF protection.
- E02-02 Redirect processing; loop/maxRedirect; preserve chain and request evidence.
- E02-03 Rate limiter per host, concurrency, Retry-After, backoff, circuit breaker, gzip/body size limits.
- E02-04 Robots policy; explicit results `fetched/skipped_robots/fetch_error`.
- E02-05 Mock server integration tests private-IP, DNS rebinding, redirects, 429/5xx.

**Acceptance:** AC-17, AC-19…AC-22. Security test MUST pass before network crawler/GUI target entry.

## EPIC-03. URL Discovery и API Entity Feed (M2)

**Результат:** полный discovery каталога и страниц через sitemap index, links, API/JSON, dedupe + provenance.

- E03-01 Sitemap XML index/gzip streaming, nested maps, limits, loops.
- E03-02 `Entity Feed v1` client cursor pagination, auth ENV, snapshot integrity errors.
- E03-03 URL collector/dedupe, source linkage, query policy, BFS links in source HTML.
- E03-04 Full/incomplete detection; `maxUrls` behavior and visible `incomplete` reason.
- E03-05 Tests: complete catalog, data source failure, query explosion, links.

**Acceptance:** AC-05…AC-08.

## EPIC-04. Durable storage и Lifecycle (M3)

**Результат:** scan survives worker death, lock, file journal, summary, resume.

- E04-01 Atomic JSON writer, JSONL append, project folder schema.
- E04-02 Scan lifecycle `queued/running/completed/incomplete/failed/interrupted/canceled`.
- E04-03 Durable queue and checkpoint/cursor; resume/idempotency.
- E04-04 Lock per project, retention + cleanup, global job concurrency.
- E04-05 Fault-injection tests kill/restart, duplicate scan start, corrupted checkpoint.

**Acceptance:** AC-07, AC-23, AC-24.

## EPIC-05. Rule Engine и SEO Rules (M4)

**Результат:** конкретные факты ошибок HTTP, canonical, sitemap, links, JSON-LD, meta и quality; нет ложной SEO-критичности.

- E05-01 Parser HTML head/h1/a, meta robots, X-Robots; stable Rule interfaces.
- E05-02 HTTP/status/redirect/expected entity/soft404 confidence rules.
- E05-03 Canonical/trailingSlash, sitemap consistency/robots.
- E05-04 Links with sourcePage; broken internal URL.
- E05-05 JSON-LD Product/Offer/AggregateRating, backend compare if provided.
- E05-06 Title/description/H1, duplicate IDs/manifest, JS button heuristic, SSR shell needs_review.
- E05-07 Unit tests for each rule, positive and negative; confidence and severity.

**Acceptance:** AC-09…AC-18.

## EPIC-06. Reports, file indexes и Diff (M5)

**Результат:** JSONL/CSV/HTML, stats, pagination-friendly index, 2 scan diff.

- E06-01 Summary aggregation and stable fingerprint.
- E06-02 CSV/HTML sanitization, escaped excerpts, 100% file-only exports.
- E06-03 JSONL storage with paging/seek strategy for 100k+; index builder.
- E06-04 Diff new/persisting/resolved/unknown; incomplete scan never false-resolved.
- E06-05 Tests consistency totals, no XSS/CSV formula, memory.

**Acceptance:** AC-25, AC-27, AC-28.

## EPIC-07. Authenticated API (M6)

**Результат:** все операции через защищённый API, в UI нет секретов, scan запускается worker.

- E07-01 Admin login/logout/session Argon2id, throttling, CSRF, secure cookies, privacy.
- E07-02 Projects CRUD/validate, scan start/stop/resume/progress.
- E07-03 Findings list/details pagination+filter, compare, downloads.
- E07-04 API schema/OpenAPI, integration auth tests and traversal tests.

**Acceptance:** AC-02, AC-03, AC-24, AC-26.

## EPIC-08. Web UI (M7)

**Результат:** usable SPA: dashboards, project setup, full scans, progress, findings, details, diff.

- E08-01 Login, navigation and protected session.
- E08-02 Projects list/new/edit/validate form with non-secret config preview.
- E08-03 Scan queue/status/progress/stop/restart and explicit incomplete state.
- E08-04 Findings list, filters, lazy-loaded evidence, exporting.
- E08-05 Comparison UI, health/status, responsive and accessibility checks.
- E08-06 E2E Playwright tests **только для панели HSI**.

**Acceptance:** AC-02, AC-03, AC-07, AC-27, AC-28.

## EPIC-09. Scheduler, Hardening, Deployment (M8)

**Результат:** безопасный частный deployment и автономные cron-сканы.

- E09-01 Cron scheduler with per-project timezone, no overlapping runs.
- E09-02 Docker reverse proxy TLS sample, headers, timeout, volume backup.
- E09-03 Security review: SSRF, XSS, CSRF, path traversal, secrets, untrusted XML/HTML, rate limits, private IP redirects.
- E09-04 Operational docs/README: onboarding of second headless site, API data-feed example.

**Acceptance:** весь security test suite, installation runbook.

## EPIC-10. E2E Demo & Pilot (M9)

**Результат:** reproducible demo without production access, pilot readiness, acceptance sign-off.

- E10-01 HTTP fixture server (index, product, category, 404, redirect, robots, JSON-LD, malformed XML).
- E10-02 Complete contract tests AC-01…28 and 2-site portability demo.
- E10-03 Performance exercise 10k/100k generated URLs with bounded memory, report UI pagination.
- E10-04 Manual QA/security sign-off, unresolved issues / known limitations.
- E10-05 Optional owner-approved SABOSPORTS scan at safe rate and comparison with prior SEO audit.

## Definition of Ready для каждой задачи

- Указана трассировка FR/AC, затронутые пакеты, схема входа/выхода, исключения, ограничения безопасности и тесты.
- Если задача требует реального аккаунта/доступа — используются моки и предусмотрен отдельный secure setup, не hardcode token.
- Любые изменения core contracts идут вместе с миграцией schemaVersion и regression fixture.

## Definition of Done для каждой задачи

- Код компилируется, typecheck проходит, тесты зелёные, нет TODO/mock placeholders в production flow.
- Документация обновлена, API/файл schemas валидируются, error path реализован.
- Выведены тестовые артефакты без секретов, и acceptance test доказан.
- Нет незаявленного расширения scope (DB/Playwright target/GSC/автоматические SEO-исправления).

## Оценка и риски **(!!!!!)**

Это продукт с веб-панелью, файловой устойчивой очередью, безопасным универсальным краулером, backend-контрактом и регрессией. Его трудозатраты существенно больше упрощённого PHP CLI-скрипта:

| Workstream | Вилка часов инженерной работы, **(!!!!!)** |
|---|---:|
| Contracts, repo, Docker | 12–20 |
| Security-oriented HTTP fetcher | 20–32 |
| Discovery + Entity Feed | 16–28 |
| Durable file storage + resume | 20–32 |
| Rule Engine + rules/tests | 24–40 |
| Reports/index/diff | 14–24 |
| Authenticated REST API | 16–28 |
| Web UI | 28–48 |
| Scheduler, deployment, hardening, final QA | 28–50 |
| **Ориентир MVP** | **178–304 ч** |

Сюда включены инженерные тесты и документация, но не длительное внедрение конкретных адаптеров чужих CMS, консультации по бизнес-правилам и эксплуатация после релиза. Codex может ускорить набор кода, но **не гарантирует** пропорционального сокращения времени проверки, безопасности и интеграционных решений. Отдельно подтвердить оценку после M1/M2.

## Рекомендуемое первое задание Codex

> Ты senior TypeScript/Node.js architect. Работай по файлам `01_PRD.md`, `02_TECH_SPEC_FOR_CODEX.md`, `03_CODEX_BACKLOG.md`. Выполни только EPIC-01. Перед кодированием: перечитай решения пользователя, сформируй ADR по структуре monorepo, Zod контрактам и файловому хранению, обозначь риски. Затем реализуй skeleton, Docker Compose, contract schema validators, typecheck/lint/unit smoke. Не создавай crawler, UI-функции, DB или CMS-интеграции в рамках этой задачи. Предоставь changed-files, команды проверки, результаты тестов и вопросы, блокирующие EPIC-02.

---

**Важно:** если у пользователя есть подключённый GitHub, Codex можно запустить непосредственно в целевом репозитории; документация и примеры должны храниться там же с версионированием. Не размещать токены и секреты в git.