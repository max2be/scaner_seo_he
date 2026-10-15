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
