# Архитектурные решения EPIC-01 / EPIC-02

Статус: baseline из PRD v1.0 и технического ТЗ; выбран для первой итерации по запросу
начать разработку. Числа производительности пока гипотезы, не результаты измерений.

## ADR-001 — Monorepo и процессы
npm workspaces, Node.js 24 LTS, TS strict, ESM. Пакеты и приложения строго по ТЗ.
web и worker стартуют независимо, share только /data; никаких SQL/Redis.
Fastify для health/API, React/Vite только собственная панель.

## ADR-002 — Контракты
Zod — единый источник runtime schemas и z.infer типов; schemaVersion = 1.0.
Неподдерживаемая версия отклоняется; изменения формата требуют миграции и fixtures.
Entity Feed использует поле id согласно нормативному контракту ТЗ; entityId в PRD
обозначает идентификатор сущности, а не второй формат JSON.
Backend endpoint требует собственного allowedHosts — как в docs/examples; hostname
сайта не даёт неявного разрешения на другие destinations. Secrets только tokenEnv.
Политика unknown не превращается в with/without; неполный скан не completed.

## ADR-003 — Файловая модель
JSON для метаданных, JSONL для журналов; один writer на scan; атомарный rename/fsync,
lock на проект. Позже: offsets/seek/buckets, ограниченный объём страницы API.
Не помещать 100k URL в один JSON ответ/память UI. Benchmark 100k — EPIC-06/10,
в этой итерации масштабирование не считается доказанным.

## ADR-004 — Безопасность по этапам
В M0 только health; root и API закрыты fail-closed (401). Нет обхода сети, логина,
проектных endpoints и отчётов. До M1 обязателен connection-bound SSRF gate;
Zod URL checks — только раннее отклонение конфигурации. Никаких внешних запросов
из примеров, телеметрии, Handoff и MCP.
Docker: non-root, read-only root, tmpfs /tmp, один локальный shared volume, localhost port.

## ADR-005 — Rule API
Rule содержит id/version/severityDefault/appliesTo/detect/recommendationKey.
Результат discriminated union: pass/finding/needs_review/not_applicable/scan_error.
Finding требует severity/confidence/evidence; scan_error отдельный результат, не P0.

## Вопросы к пилоту (не блокируют M0)
- Подтверждено пользователем: backend — публичный HTTPS; private режим не требуется.
- Подтверждено пользователем: каталог 10 000–100 000 URL. Бюджет времени пока неизвестен; 100k soft-limit не гарантия SLA.
- Реальный target/pilot разрешается владельцем отдельно; production сайт не сканируем.

## Границы приёмки
M0 проверяет контракты двух разных проектов и запуск процессов; это не AC-04
реального сканирования. Полный AC-01 включает UI, который предусмотрен EPIC-08.
Не объявлять эти AC выполненными только на основании skeleton smoke.

## ADR-006 — HTTP transport, EPIC-02
Native node:http/https with a fresh connection per request, no environment proxy or cookies.
Resolve all A/AAAA answers; reject a mixed public/private set. Select one approved address;
connect to its numeric IP, preserve original Host, TLS SNI and certificate identity check.
No second hostname lookup at connection time. Check socket peer matches the selected IP.
Every redirect re-enters the same policy, including robots and HTTPS downgrade rejection.
Test-only dependencies/fixtures are not a project setting or an allow-private mode.

## ADR-007 — Resource and robots policy, EPIC-02
One client per project/run; global concurrent requests and per-host request start intervals.
DNS + connection/headers/body covered by the per-attempt whole timeout; socket idle timeout too.
Cap encoded and decoded body bytes; gzip/deflate/br supported; no raw HTML excerpt in evidence.
Body is bounded transient parser input, never automatically persisted. Query values in metadata
are redacted. Retry only 429/500/502/503/504, at most min(config.maxRetries,2); bounded backoff.
Retry-After delays the whole host queue. Above 60s, a requested retry returns retry_after_exceeds_budget; subsequent host calls remain circuit-blocked until that time.
Five consecutive transient HTTP/network failures open a per-host circuit for 60s.
Robots 404/410 allow, 401/403 deny, other failures fail closed with robots_unavailable.
Cache robots per origin for 1h, deduplicate concurrent loads; check redirect targets too.
robots.txt itself is exempt from recursive robots checks, never from network safety.
For a proposed P0 HTTP404/410 caller may request one confirmation; both responses retained.
This is evidence only, not a P0 classification (rules belong to EPIC-05).

## ADR-008 — EPIC-03 discovery pipeline
SafeHttpClient gains a generic streaming sink, keeping numeric-IP/TLS/rate/robots controls.
Stream XML to a private temporary file, then parse incrementally with bounded token size.
Each sitemap has independent 50000-entry/50000000-byte limits; HTTP guardrail may be lower
and must produce an explicit source_error, never silent truncation. Detect gzip by magic
bytes after HTTP decoding, so Content-Encoding and .xml.gz are both supported.
Reject DTD/entities and unsupported XML encodings. Do not fetch XML external resources.

Discovery uses a storage port and disk-backed ephemeral records + BFS queue. All edges are
append-only provenance events; unique URL records merge sourceSet/entityRefs. No 100k-URL
Map or Promise.all catalog. Durable resume/leases/fsync lifecycle belongs to EPIC-04.
Limits, source errors and crawl-depth exhaustion with eligible unseen links => incomplete.
Query policy deliberately excludes unknown parameter combinations; exclusions are counted.
Normalization never invents a trailing-slash policy when unknown/preserve.

## ADR-009 — Backend source scope
Entity Feed v1 remains cursor-based nextCursor contract from the technical spec. Page-based
foreign APIs require an adapter; no new input contract is guessed. Entity id follows v1.
Backend client reads tokenEnv at runtime, without logging its value, uses independent hosts,
requires HTTPS, disables website robots for the API, and locks every hop to endpoint origin.
Cursor is opaque; only cursor/limit query parameters are changed, values redacted in metadata.
Snapshot absence is unknown; changes/removal mid-stream are source_error. Partial imports
may remain as facts but cannot support missing/deleted assertions; source completeness false.
Existing persisted schemas v1 remain unchanged; new discovery/spool schemas are additive.

## ADR-010 — EPIC-04 commit authority и file schema
Новых противоречий PRD/ТЗ перед реализацией EPIC-04 не найдено. Добавлены версии 1.0
Checkpoint/RecoveryState/DurableEvent/SitemapTask; прежние persisted schemas не меняются.
EPIC-03 spool остаётся ephemeral и не принимается за новый durable формат; автоматическая
миграция невозможна без исходного checkpoint. Новый scan создаётся отдельно.
WAL с checksum и атомарный checkpoint — авторитет; derived buckets/JSONL восстанавливаются
потоковым replay. Commit после sitemap, feed page, URL+links; текущая единица может
повториться после сбоя, завершённые единицы не требуют повторной полной выгрузки.
HTML body не сохраняется. Manifest публикует только подтверждённый прогресс.

## ADR-011 — Linux locks, worker recovery и retention
Локальный Linux volume и системный flock, без expiry/PID unlink lock. Guardian удерживает
lock до pipe EOF; его неожиданная потеря приводит к fail-stop worker. Одинаковый durable
pool.json ограничивает все процессы, один lock на проект. SIGTERM → interrupted;
после SIGKILL stale running → interrupted, явный resume. Queued автоматически подхватывается.
Exhausted incomplete сохраняет ошибки/лимиты; для нового наблюдения создаётся новый scan.
Retention явно задан оператором, архивирует до удаления, защищает активные/pinned,
проверяет совпадение архива после сбоя. NFS/SMB/multi-host не поддерживаются. Полный
100k benchmark, REST/UI и cron не входят в EPIC-04.

## ADR-012 — EPIC-05 analysis configuration and evidence
Перед реализацией: новых неразрешённых противоречий PRD/ТЗ не обнаружено.
ProjectConfig v1 остаётся неизменным. Severity overrides, порог redirect chain и явно
заданные unknown-route probes — отдельный валидируемый rules.json, замороженный в scan.
Случайные несуществующие URL не генерируются. Публичный HTML не исполняется; сохраняются
ограниченные типизированные факты, hashes и безопасные структурные excerpts, не HTML body.
X-Robots передаётся парсеру transient allowlisted headers без cookies/прочих headers.
Entity-правила учитывают полноту фида и snapshot; P0 HTTP404/410 требует опубликованной
expected-indexable entity и двух согласованных GET, а не истории поискового робота.

## ADR-013 — EPIC-05 durable analysis and backwards compatibility
Новые сканы используют checkpoint/WAL 1.1 с отдельным analysis cursor и типизированными
facts/findings/errors. Reader сохраняет поддержку 1.0; legacy discovery scans не
переинтерпретируются как SEO-аудит. Migration создаёт 1.1 для новых запусков; regression
fixture проверяет чтение 1.0. Html facts и диагностические GET фиксируются в транзакции
URL, findings — отдельным проходом по завершённым фактам/финальной provenance с checkpoint
на каждый URL. Это позволяет учесть ссылку, найденную после проверки её target, и
продолжить анализ без повторного сетевого обхода. Report/diff/UI остаются EPIC-06…08.

## ADR-014 — EPIC-06 immutable report generations
Перед реализацией: PRD/ТЗ требуют report summary в summary.json, но этот путь уже имеет
persisted DiscoverySummary1.0. Сохраняем прежний контракт, добавляем report-summary.json
и версионированный bundle reports/GENERATION с атомарным reports.json pointer. Findings
для экспорта читаются из подтверждённого WAL, не из возможного незакоммиченного JSONL tail.
Core persisted schemas1.0/1.1 не меняются, report/index/diff schemas additive1.0.
Reports pure orchestration/formatting через ports; file I/O/indexes в storage, composition
в worker. Report failure не объявляет scan completed; resume может повторить exports без GET.

## ADR-015 — EPIC-06 seek indexes and conservative comparison
JSONL byte offsets + bounded ID hash-trie leaves; все данные на диске, нет Map всего каталога.
Фильтры используют селективный pointer index и ограниченную страницу/scan budget.
Diff — streaming merge sorted stable IDs, без каталога в памяти. Missing baseline finding
может стать resolved только при завершённом сопоставимом новом скане и неизменных
scope/rule semantics. Incomplete/incompatible/needs_review отсутствие — unknown.
HTML self-contained/no scripts/network; все untrusted строки escaped. CSV RFC4180 с
защитой formula/control-prefix injection, BOM по export option без изменения ProjectConfig.
AC-28 UI часть остаётся EPIC-08, в EPIC-06 доказывается storage pagination/100k fixture.

## ADR-016 — EPIC-07 auth and command boundaries
Before implementation: GET compare cannot create a diff because the specification also
forbids state changes on GET. Add POST compare to queue worker work; GET reads ready
comparisons, including conservative unknown for incomplete pairs per PRD/EPIC-06.
Validation reachability is an asynchronous worker operation, not a crawler in web.
Resume is a durable command, not a web call into worker. Project deletion means archive;
scan snapshots are immutable. Existing project.json and scans remain readable.
Single admin: Node24 built-in asynchronous Argon2id (PHC), file sessions, bounded persistent
login throttling and at most two concurrent KDFs. Cookies always Secure/HttpOnly/SameSite=Strict;
POST login requires configured Origin, authenticated writes also require CSRF.
Missing auth configuration fails closed; health remains usable. No anonymous docs/files/UI.
Node's Argon2 API is experimental in pinned Node24, with no third-party native dependency.

## ADR-017 — operator credential bindings and additive API storage
Remote project editing must not turn arbitrary process.env names into an exfiltration
primitive. API bearer references require BACKEND_CREDENTIAL_ORIGINS operator mapping
{ENV_NAME:[HTTPS_ORIGIN]}; web receives references/origins only, worker receives actual
backend credentials. No mapping means API cannot enable bearer for that origin.
ProjectConfig/scans/checkpoints/report formats remain unchanged. Add archive.json,
Operation1.0 and SessionFile1.0; old project.json is readable with archived=false.
Project PATCH replaces top-level fields/nested objects and may archive/restore in a
separate request, keeping each mutation atomic. Resume/compare/validate commands reserve
a project; latest50 operation records and32 sessions are retained. Existing Linux flock
and global worker pool guard all job kinds. GET comparison only reads current generations.

## ADR-018 — sum1-7 branch consolidation and declaration style
Origin main merged the independent EPIC-01 foundation (PR#1); it was not an ancestor
of the EPIC-01…06 branch. sum1-7 includes both histories and committed EPIC-07.
All23 add/add conflicts use the validated implementation through EPIC-07. Legacy
server/worker entrypoints, root Compose, duplicate ESLint and mismatched Vite config
are superseded; historical ADR/status documents move under docs/history/epic-01-foundation.
One active build, deployment and lint configuration remain; original specifications unchanged.
User clarified preferred style: const immediately before first use, narrow block scope,
class fields above constructor/methods. Do not hoist initializers or weaken const en masse.
ESLint enforces no variable/class use before definition, prefer-const/no-var and field order;
hoisted named functions and type-only references are allowed. Scheduler callback ordering
is clarified without changing cancellation/permit behavior. See docs/SUM1-7-RESULTS.md.
