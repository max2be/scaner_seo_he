# EPIC-08 — Web UI (M7): результаты

Реализован EPIC-08 из backlog. Основание: запрос пользователя «Преступим к epic 8».
Работа выполнена в существующей `sum1-7`, без worktree и изменений main. EPIC-09
не начат. Исходные PRD, ТЗ, backlog и audit coverage не редактировались.

## Решения до реализации

ADR-019 в `docs/DECISIONS.md` описывает согласование FR-06 и E08 с действующими DTO.
Противоречий между PRD и ТЗ, требующих выбора пользователя, не найдено. Обнаружены
пробелы API: конкретные source errors и экспорт delta не предоставлялись UI;
добавлены два защищённых read-only endpoint поверх существующих файлов.
Полная HTTP-цепочка и глобальная worker/disk telemetry не входят в имеющиеся DTO;
интерфейс явно указывает отсутствие этих сведений. Сведения не выдумываются.

## Реализовано

- E08-01: русский login, защищённая навигация, restore/logout, абсолютный session
  timeout,401/CSRF rejection очищают private UI. CSRF только в памяти, cookie HttpOnly.
  Публичен login shell с exact static allowlist/CSP; данные и attachments закрыты.
- E08-02: dashboard с карточками последнего запуска/coverage/severity, полный профиль
  new/edit, URL/hostname/schema errors, nonsecret preview, revision-aware save,
  archive/restore, source validation operation. Сохранённый draft проверяется без записи.
- E08-03: scan history и динамика обработанных URL, полный запуск, cancel acknowledgement,
  resume worker operation, новый immutable запуск отдельно от resume;409 с current scan link.
  INCOMPLETE и manifest reasons, source diagnostics, counters без ложного100%.
- E08-04: bounded cursor findings/filter/sort, null totals и empty+nextCursor, отдельная
  карточка evidence/expected/actual/confidence/рекомендация, HTML как текст; private streaming exports.
- E08-05: baseline comparison, worker202 polling, new/persisting/resolved/unknown/reason,
  delta CSV/JSONL/HTML, system health, retention и границы доступных метрик; responsive UI.
- E08-06: Playwright только для панели HSI, disposable local TLS, file-backed10001
  findings, реальные API/worker операции, browser network guard, базовая доступность.
  CI устанавливает Chromium и выполняет E2E после обычных check/smoke.

Добавлены `ScanDiagnosticsQuerySchema` / `ScanDiagnosticsPageSchema`; persisted
formats1.0/1.1 и существующие request/response contracts не изменены. Source errors
читаются максимум256 KiB/100 records, cursor связан с выбранным snapshot.
Delta download проверяет актуальность generations и не строит diff на GET.
БД, Redis, внешние SaaS, CMS-specific логика, target-site browser crawler не добавлялись.

## Созданные файлы

- `apps/ui/src/App.tsx` — auth shell, маршруты, layout и health.
- `apps/ui/src/api.ts` — runtime-validated same-origin API client, session epoch/CSRF.
- `apps/ui/src/hooks.ts` — abortable resources/polling и hash navigation.
- `apps/ui/src/components/common.tsx` — сообщения, coverage, badges, pager.
- `apps/ui/src/pages/projects.tsx` — dashboard, проекты, форма, worker operations.
- `apps/ui/src/pages/scans.tsx` — progress, diagnostics, findings/evidence, comparison/export.
- `apps/ui/src/styles.css` — локальные стили, focus и responsive layout.
- `apps/web/src/ui.ts` — exact static allowlist, O_NOFOLLOW, size bound, CSP.
- `apps/web/src/diagnostics.ts` — bounded source diagnostics reader.
- `playwright.config.ts` — Chromium, local TLS fixture, SPKI pin для test certificate.
- `tests/e2e/server.mjs` — disposable HSI/TLS/worker/file reports fixture.
- `tests/e2e/ui.spec.ts` —13 browser acceptance tests.
- `tests/ui-api-client.test.ts` —5 client/session/privacy/error tests.
- `tests/ui-static.test.ts` —2 static boundary/security tests.
- `docs/web-ui.md` — запуск и работа с панелью, API additions, browser test runbook.
- `docs/EPIC-08-RESULTS.md` — этот отчёт.

Обновлены web app/auth/routes/main, contracts/api, UI entrypoint и package manifest,
root package/lock/TS test config, CI/ignore files, прежние auth/report/runtime tests,
README/development/API docs, ADR, AGENTS и локальные AI Factory project artifacts.
Добавлена только dev-зависимость `@playwright/test`1.64.1; UI явно объявляет уже
используемые workspace contracts и Zod. Проверенные vendor skills не изменены
(SHA256 совпали для10 файлов); Handoff/MCP/телеметрия и внешняя синхронизация не использованы.

## Проверки и доказательства

| Проверка | Результат |
| --- | --- |
| `npm ci --ignore-scripts` | Успех,237 packages |
| `npm run check` | ESLint, TypeScript, **423 tests /27 files**, сборка пакетов и UI — успех |
| `npm run smoke` | Web/worker health200, private401, graceful shutdown — успех |
| API regression после финальных delta security assertions | **6 tests**, включая diagnostics/stale cursor, private GET/HEAD, traversal, OpenAPI — успех |
| Chromium Playwright через локальный HTTPS | **13 tests**,44,5с — успех |
| 100k report/index/diff child | 100000 findings; unknown100000, resolved0 для incomplete after; seek10 records/3,01мс |
| Память100k | V8 cap96 MiB; peak heap71,90 MiB; RSS186,80 MiB, ниже256 MiB |
| Время benchmark |106,08с в этой среде; измерение проверки, не SLA |
| Docker build / Compose config / health | Успех; оба сервиса healthy, nonroot |
| UI из production image | Shell/JS/CSS200, CSP, private API/data paths401 — успех |
| Production-image API smoke | Argon2id, cookie, CSRF, CRUD, queue/409, resume, exports, OpenAPI, revoked logout — успех |
| Production-image reports smoke | SEO, replay, seek, offline rebuild, diff, no false P0/no raw HTML or cookies — успех |
| Mobile/labels/keyboard/CSP |390px без horizontal page overflow, labels/skip link; hostile excerpt текстом, внешних запросов нет |
| `git diff --check`, спецификации/skill hashes | Успех, исходные требования и vendor skills сохранены |

Browser tests покрывают AC-02/03/07/27/28 со стороны панели; existing API/worker/security
suites сохраняют backend покрытие. Это приёмка E08, не заявление о выполнении всего MVP.
Конфигурационный draft cloud environment обновлён: install_script и start_skill с
рабочими build/check/browser/start командами; network/repository membership/secrets
не менялись. Draft сохранён, но не применён и не опубликован автоматически.

## Ограничения и следующий этап

- Для реального browser access оператор всё ещё задаёт admin PHC hash/PUBLIC_ORIGIN
  и внешний HTTPS proxy. Синтетический TLS тест не подтверждает конфигурацию production.
- Chromium проверен; Firefox/WebKit и полный WCAG-аудит не выполнялись.
- Полный HTTP response chain отсутствует в Finding DTO, worker heartbeat/свободный
  диск не опубликованы API; UI показывает только доступные факты. Их расширение —
  отдельные контракты, а не чтение всего журнала браузером.
- System status отражает web/volume readiness; проверка источников — sampled preflight.
  No-source scan остаётся incomplete после resume. Нет поисковых метрик и JS анализа.
- Реальные сайты не сканировались. Операторские пароли не создавались/не запрашивались.

Рекомендация для EPIC-09: scheduler с timezone/idempotency/locks, production TLS sample,
backup/restore и дисковые лимиты, security/acceptance pass. Перед пилотом отдельно
проверить выбранные origin, egress policy и права volume. EPIC-09 начинать новым заданием.

Изменения EPIC-08 находятся в рабочем checkout `sum1-7`; коммит и push этого этапа
не выполнялись автоматически. Предыдущие коммиты сохранены.
