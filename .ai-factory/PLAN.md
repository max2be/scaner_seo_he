# EPIC-05 — M4
Original Request: приступаем (после Git checkpoint EPIC-01…04)
Источник: docs/03_CODEX_BACKLOG.md; FR-04; AC-09…18.

- [x] ADR: additive rules profile and storage1.1 with legacy1.0 reader/fixture.
- [x] Bounded source HTML/JSON-LD facts, applicable meta/X-Robots, safe evidence.
- [x] Stable Rule API, confidence/severity gates, 31 SEO rules and error isolation.
- [x] Worker URL facts transaction, final provenance analysis, disk title groups, resume cursor.
- [x] Positive/negative unit and synthetic HTTP/TLS integration fixtures.
- [x] Final clean install/check/smoke, Docker validation and results report: 319 tests passed; production replay verified.

No EPIC-06, production scans, external skill sync, commits or publishing without user task.

# EPIC-06 — M5
Original Request: делаем эпик 6
Источник: docs/03_CODEX_BACKLOG.md; FR-07; AC-25/27/28 (UI часть E08).

- [x] ADR-014/015: preserve discovery summary, immutable report/index/diff1.0.
- [x] Streaming summary/CSV/HTML via ports, escaping/formula protection, configurable BOM.
- [x] File seek/filter indexes, bounded ID trie/sort, page and ID lookup.
- [x] Conservative streaming diff with incomplete/scope/policy/version gates.
- [x] Automatic worker publication and offline operator CLI, no-refetch export recovery.
- [x] Final clean check: 361 tests passed; 100k memory/seek/diff; smoke/Docker; docs/EPIC-06-RESULTS.md.

No EPIC-07, production scans, external skill sync, commits or publishing without user task.

# EPIC-07 — M6
Original Request: перейдем к EPIC-07
Источник: docs/03_CODEX_BACKLOG.md; AC-02/03 (API)/24/26.

- [x] ADR-016/017: GET compare read-only, POST queues worker; immutable scan schemas.
- [x] Async Argon2id/PHC, rotating file sessions, Origin/CSRF, persistent throttle/privacy.
- [x] Projects create/read/patch/archive, revisions, frozen snapshots and safe paths.
- [x] Durable start/resume/validate/compare, global worker capacity and cancel control.
- [x] Seek findings/details/summary, streamed authorized exports, authenticated OpenAPI.
- [x] Final check:412 tests/24 files passed; 100k/HTTP/Docker smokes; docs/results and reusable cloud startup draft saved.

No EPIC-08, production scans, external skill sync, commits or publishing without user task.

# Объединение sum1-7
Original Request: собрать ветки EPIC-01…07, проверить конфликты, ошибки и объявления.
Уточнение пользователя: const перед первым использованием, поля класса сверху.

- [x] Сохранить EPIC-07 и объединить main/foundation с историей EPIC-01…06.
- [x] Разрешить 23 конфликта, убрать устаревшие конфигурации и сохранить исторические документы.
- [x] Проверить объявления, закрепить правила ESLint и regression tests.
- [x] Check: 416 tests/25 files; smoke, Docker build/runtime, 100k report benchmark.
- [x] Оформить docs/SUM1-7-RESULTS.md; отправка sum1-7 разрешена текущим Git-заданием.

EPIC-08 не начинать без следующего задания. main напрямую не изменять.

# EPIC-08 — Web UI (M7)
Branch: sum1-7. Created: 2026-10-15.

## Original Request
Преступим к epic 8

## Settings
- Testing: yes — Vitest API/UI client, Playwright только HSI.
- Logging: minimal — без credentials, browser traces и response bodies.
- Docs: yes — runbook, решения, результаты/ограничения.

## Requirements Reconciliation
Источники: PRD FR-01/05/06/07, ТЗ §10/11/14, backlog E08 и текущие API DTO.
Решения до реализации: ADR-019; исходные требования не редактируются.

| Состояние/операция | Инвариант | Проверка |
| --- | --- | --- |
| Анонимный/expired | Только login shell, private API401, нет client storage токенов | TLS browser login/logout/expiry |
| Project new/edit | Runtime schema, nonsecret preview, revision conflict409 | Форма invalid/valid + реальный example |
| queued/running/stopped | Только worker requests, cancel/resume/new scan различаются | API+browser lifecycle |
| incomplete | Причины/coverage, не ложные100% | Browser fixture maxUrls |
| Findings/diff paging | <=200, null total, empty+cursor, stale reset | UI E2E seek/filter |
| Evidence/export | React escape, lazy details, private streaming | XSS/download/anonymous tests |
| Compare ready/missing/stale | GET не пишет, POST202 polling, unknown не resolved | Реальный worker diff+browser |
| Health | Только реальные доступные факты | UI status, unknown metrics |

## Tasks
- [x] E08-01: Session client, login/logout/expiry, navigation, exact static allowlist/CSP.
- [x] E08-02: Projects dashboard, create/edit/validate form and config preview.
- [x] E08-03: Scan history/progress/cancel/resume/restart and operation polling.
- [x] E08-04: Findings filters, cursor paging, lazy evidence and private exports.
- [x] E08-05: Comparison UI/delta export, health, responsive/accessibility.
- [x] E08-06: Playwright TLS fixture, regression/acceptance checks, CI and docs.

## Commit Plan
Рекомендуемые checkpoints: UI/contracts, browser tests, verified docs. Автоматические
коммиты/публикация не требуются текущим заданием; не изменять main и не начинать E09.

EPIC-08 validation: 423 tests/27 files;13 Chromium TLS E2E;100k memory benchmark; Docker API/reports/UI smokes. Results: docs/EPIC-08-RESULTS.md. No EPIC-09, commits or push in this iteration.

# EPIC-09 — Scheduler, Hardening, Deployment (M8)
Branch: sum1-7. Created: 2026-10-16.

## Original Request
перейдем к epic 9

## Settings
- Testing: yes — calendar/DST, durable crash/race cases, API/browser, backup integrity, TLS proxy.
- Logging: minimal — safe codes, no credentials/request bodies/access logs.
- Docs: yes — deployment, second site/feed, backup/recovery, security review/results.

## Requirements Reconciliation
Источник истины: PRD FR-05/06 и UC-06; ТЗ §11/12/15; backlog E09. ADR-020/021.

| Комбинация | Правило | Проверка |
| --- | --- | --- |
| New/config changed/disabled | Нет исторического backlog, operator opt-in | calendar/storage tests |
| Missed/clock rollback/DST | Один последний slot, UTC idempotency, не повторять | calendar and restart tests |
| Concurrent/manual/active/archived | Общий project flock, операции и worker pool | integration/race tests |
| Crash before/after directory commit | Pending intent + deterministic ID, retention guard | fault injection tests |
| HTTP/TLS/no credentials | Local base fail-closed, production HTTPS only | proxy/private API regression |
| Offline backup/restore/malicious input | No auth state/links/overwrite, digest verification | roundtrip/corruption/traversal |

## Tasks
- [x] E09-01: Cron/timezone core, SchedulerState1.0, durable intent, worker integration, UI/API settings/status.
- [x] E09-02: TLS nginx overlay, timeout/headers/limits, private offline backup/restore.
- [x] E09-03: Local security review + focused regressions; all security suites.
- [x] E09-04: Second-site/feed onboarding, installation/restore runbook, final check/E2E/Docker/results.

Сохранён локальный patch/archive исходного EPIC-08 вне checkout. Старые форматы не менять;
новый scheduler state additive1.0. Ни production targets, ни EPIC-10 не запускать.

Validation: npm ci/check (463 tests/29 files)/smoke;14 Chromium E2E; production Docker build/healthy services; API/reports/backup/TLS smokes; examples and skill hashes. Results: docs/EPIC-09-RESULTS.md. No EPIC-10, commits, push or production targets.

# EPIC-10 — E2E Demo & Pilot (M9)
Branch: sum1-7. Created: 2026-10-16.

## Original Request
Переходим к эпик-10

## Settings
- Testing: yes — 2-site HTTP/TLS fixtures, deterministic reruns/diff, 10k/100k durable load, AC matrix, UI/Docker regression.
- Logging: minimal — synthetic counts/metrics only, no credentials/bodies/access logs.
- Docs: yes — reproducible demo, AC matrix, manual QA/pilot checklist/results.

## Requirements Reconciliation
PRD §3.2/UC-01…07, ТЗ §14 AC-01…28, backlog E10-01…05. ADR-022.
Новые противоречия не выявлены. Production scan optional и требует отдельного разрешения.
Replay load измеряет storage/pipeline, не HTTP throughput; real sockets остаются в demo/security tests.

## Tasks
- [x] E10-01/02: scripts/fixtures/demo-site.mjs + scripts/demo.mjs, tests/pilot-demo.test.ts — 2-site full pipeline, labelled positives/negatives, stable reruns/release diff, malformed XML/incomplete. Зависимость: существующие worker/storage/reports. Логи: только synthetic assertions/counts.
- [ ] E10-03: scripts/fixtures/pipeline-load.mjs + scripts/benchmark-pipeline.mjs — generated 10k/100k, heap/RSS/disk/throughput metrics, all URLs accounted, report pagination. Логи: counts/metrics, без HTML/ENV. Большой benchmark запускается явно отдельно от обычного check.
  Harness реализован;10k completed. Найден и исправлен cleanup OOM (ADR-025),469 regression tests/16 browser scenarios passed. Повтор100k остановлен после уточнения пользователя о достаточности тестов: discovered100000, last logged processed89774. Полный100k после fix не засчитывается; этот gate открыт.
- [x] E10-04: docs/ACCEPTANCE-MATRIX.md + docs/pilot.md — трассировка всех AC, воспроизводимые команды, локальный manual QA и честные ограничения. README/CI/dev docs обновить после проверок.
- [x] E10-05: документы owner-approved pilot procedure; production scan не выполнять в этом задании. Секреты только через operator env, без вывода.

## Commit Plan
Логические checkpoints: demo/tests; load harness; acceptance/docs. Автоматические коммиты и push
не требуются. Существующий WIP EPIC-08/09 сохранён в patch/archive /tmp вне checkout.
Roadmap linkage skipped: backlog является источником этапов, отдельной roadmap нет.
