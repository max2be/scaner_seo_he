# EPIC-09 — результаты

Дата: 2026-10-16. Ветка `sum1-7`, работа поверх сохранённого EPIC-08.
Реализован только следующий этап backlog E09-01…04. EPIC-10 и production pilot не запускались.
Коммиты/push этим заданием не выполнялись; изменения EPIC-08/09 остаются локальными.

## Реализовано

- Cron из пяти числовых полей, IANA timezone, DST/clock rollback, один последний catch-up.
  Пакет `cron-parser@5.10.2` закреплён lockfile. Opt-in worker, по умолчанию выключен.
- Durable SchedulerState1.0, intent перед atomic queue commit, deterministic ID по
  `(projectId, scheduledAt)`, project flock, отсутствие overlap с manual/operations.
  Повтор после crash идемпотентен; retention защищает ещё не подтверждённый scan.
- Семантическая проверка cron в create/patch/validate, nullable PATCH только для удаления
  настройки, private GET scheduler snapshot, русские поля расписания и статус в UI.
- Nonroot pinned nginx TLS overlay, read-only filesystem/tmpfs, таймауты, body/connection/login
  limits, HSTS/nosniff, exact SNI, без access logs и без доступа proxy к данным.
- Offline file backup/restore CLI с manifest SHA256 и проверкой payload, private modes,
  исключением auth, запретом ссылок/traversal/перезаписи, streaming64 KiB.
- Локальный security review и runbook TLS/scheduler/backup/recovery/second-site/feed.
  Базовые project/scan/checkpoint/report formats не изменены; SchedulerState1.0 добавлен отдельно.

Решения до реализации: [ADR-020/021](DECISIONS.md). Исходные PRD, ТЗ, backlog и audit coverage
не редактировались. Нет CMS-зависимостей, БД, Redis, SaaS, target-browser crawling.

## Созданные файлы EPIC-09

| Область | Файлы |
| --- | --- |
| Calendar/contracts | `packages/core/src/schedule.ts`, `packages/contracts/src/scheduler.ts` |
| Storage | `packages/storage/src/schedule-state.ts`, `packages/storage/src/backup.ts` |
| Worker | `apps/worker/src/scheduler.ts`, `apps/worker/src/backup.ts` |
| Deployment | `deploy/nginx.conf`, `deploy/compose.tls.yaml` |
| Tests | `tests/scheduler.test.ts`, `tests/backup.test.ts` |
| Runtime smoke | `scripts/smoke-tls.mjs`, `scripts/smoke-backup.mjs` |
| Docs/examples | `docs/deployment.md`, `docs/EPIC-09-SECURITY-REVIEW.md`, `docs/EPIC-09-RESULTS.md`, `docs/examples/project-second.example.json` |

Изменены существующие exports/packages/lockfile/root scripts; storage scans/projects;
web routes/error mapping/API contracts; worker startup; UI projects/API messages;
Compose/env examples; один browser schedule scenario; README/development/API/UI docs,
AGENTS и project AI Factory context/plan/architecture. Vendor skills не изменены.
Файлы предшествующего UI этапа перечислены отдельно в [EPIC-08-RESULTS.md](EPIC-08-RESULTS.md).

## Проверки

| Команда/сценарий | Результат |
| --- | --- |
| `npm ci --ignore-scripts` | Установка из lockfile успешна |
| `npm run check` | ESLint, TypeScript, **463 tests /29 files**, production build успешны |
| `npm run smoke` | Web/worker health, private401, SIGTERM exit0 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e` | **14 Chromium TLS E2E**; включая invalid/valid cron, timezone, reload/removal |
| Calendar/storage/backup regression | **40 новых тестов**: calendar/DST, race/crash/restart/retention/forged identity, реальный worker opt-in, API, backup integrity/paths/no overwrite |
| 100k benchmark в check | 100000 findings/diff; heap71.96 MiB, RSS193.10 MiB, cap96 MiB;100.41s |
| `node scripts/cloud-docker-build.mjs` | Новый production image собран; TLS/npm integrity не отключались |
| Base + TLS Compose `config --quiet` | Успешно, overlay с синтетическими значениями без публикации credentials |
| Base Compose `up -d --wait` | Web/worker healthy, scheduler выключен |
| Runtime API smoke | Argon2id/session/CSRF/CRUD/queue409/resume/exports/OpenAPI/logout; UID1000 |
| Runtime reports smoke | SEO pipeline, seek/diff/replay/no raw HTML/cookies; UID1000 |
| Runtime backup smoke | Roundtrip, auth excluded, verified restore; UID1000 |
| `node scripts/smoke-tls.mjs` | Доверенный TLS, nginx config, UID1000, HSTS/assets/private401/session/CSRF/logout, unknown SNI rejected, body413 |
| Example schemas / installed skills | Два project examples валидны;10 reviewed skill hashes совпадают |
| Финальный lint и `git diff --check` | Успешно |

TLS smoke использует отдельные disposable containers/network/test certificate; операторский
volume/env не используются. Браузер обращается только к собственной панели. Реальные сайты,
feed tokens и production сертификаты не использовались; fixtures удаляют свои ресурсы.

Сборка первоначально остановилась по ENOSPC в cloud Docker VFS. Удалены только воспроизводимый
builder cache и dangling images с label этого Compose project; данные/volumes сохранены.
Повторная сборка успешна. TLS smoke выявил read-only temp-path настройку nginx; все temp paths
перенесены в /tmp, повторная проверка прошла. Тестовый сертификат имеет отдельные private modes.

## Эксплуатация и следующий этап

См. [deployment.md](deployment.md) и [security review](EPIC-09-SECURITY-REVIEW.md).
Реальная публикация требует operator hostname/certificate/admin hash/firewall. Backup выполняется
только при остановленных writers и восстанавливается в новый каталог; SHA256 не заменяет подпись
или шифрование. UI scheduler snapshot не является live heartbeat. Мониторинг диска/inodes и
certificate renewal остаются операторскими задачами, а не скрыто обещанными сервисами.

Следующий этап — EPIC-10 отдельным заданием: полная матрица AC-01…28, воспроизводимая
двухсайтовая демонстрация,10k/100k pilot/load, manual QA/sign-off. Имеющийся 100k report benchmark
не заменяет нагрузочную проверку полного crawler pipeline. Реальные сканы — только с разрешения
владельца, согласованной allowlist и безопасными лимитами.

Cloud setup start instructions сохранены в draft; применение требует Review/Save/Publish
в настройках среды. Это не публикация Git-изменений и не доказательство восстановления WIP
в новой задаче: незакоммиченные изменения следует сохранить в Git перед переносом окружения.
