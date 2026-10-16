# Локальный security review — EPIC-09

Дата: 2026-10-16. Область: исходный код EPIC-01…09, runtime schemas,
существующие regression suites, новые scheduler/backup/TLS сценарии.
Это локальная проверка реализации и поведения, не внешний penetration test и не CVE-аудит.
Продукт остаётся private single-admin сервисом с доверенным владельцем Linux/DATA_DIR.

## Проверенные границы

| Риск | Механизм | Подтверждение |
| --- | --- | --- |
| SSRF, private IP redirect, DNS rebinding | Safe HTTP: allowlist/HTTPS, проверка всех A/AAAA и каждого redirect, public-IP policy, socket pinning и TLS hostname; без ambient proxy | `http-policy`, `http-client`, `http-robots`, `api-security` tests; локальные sockets, mixed DNS/private/mapped IPv6/redirect cases |
| Backend credentials | Публичный HTTPS origin, tokenEnv reference привязан к approved origin, значение читает только worker; redirect не переносит Authorization к чужому origin | `api-security`, discovery/feed tests; UI не принимает значение токена |
| Untrusted XML | Streaming saxes parser, запрет DOCTYPE/entities, ограничения depth/token/body/decompression/URL count | `discovery-parser`, `discovery-flow`, `http-client` tests |
| Untrusted HTML/XSS | Bounded parsing исходного HTML без исполнения JS; redaction фактов, React text rendering; report escaping и sandbox CSP | `seo-parser`, `reports`, `ui-static`, Chromium malicious-evidence/no-external-network assertions |
| CSV formula injection | Escaping опасных префиксов CSV; stable report projection | `reports`, `report-integration`, `api-reports` tests |
| CSRF/session/anonymous access | Argon2id, hashed file sessions, Secure/HttpOnly/SameSite=Strict cookie, exact Origin и CSRF на writes, expiry/revocation | `api-auth`, `api-process`, TLS Chromium login/logout/expiry; production-image proxy smoke |
| Brute force / resource limits | Persisted bounded login throttle и body/query/page/response limits; nginx login rate/connection limits и timeouts | `api-auth`, `api-security`, `ui-static` suites; TLS smoke oversize body413; review nginx configuration |
| Path traversal / arbitrary file reads | Runtime IDs, canonical safeDataPath, no-follow reads, bounded cursors, explicit download/static allowlists | `api-security`, `api-reports`, `ui-static`, durable-storage tests |
| Secrets/logs/exports | Generic errors, redaction, no response-body/access logging; UI only same-origin assets, no client token storage | `api-auth`, `api-process`, SEO/report/browser assertions; review worker scheduler/backup CLI error paths |
| Duplicate automatic scans / overlapping runs | Project flock, normalized UTC slot, deterministic ID, durable pending intent/atomic queue commit, retention guard; scheduler only queues | `scheduler.test.ts`: races, active/manual/archived state, crashes before/after commit, restart, clock rollback, DST, forged pending identity |
| Backup traversal/corruption/secret persistence | Explicit offline CLI, private modes, exclusive NEW target, manifest SHA256, streamed verification, reject links/unsafe names; exclude root auth and locks | `backup.test.ts`: roundtrip, real report aliases, corrupted metadata/payload/manifest, symlinks/hardlinks, traversal, overlap, no overwrite |
| Public deployment | Pinned nonroot nginx, read-only root, capabilities dropped, TLS1.2/1.3, exact SNI, HSTS/nosniff, no access logs, bounded proxy timeouts | `deploy/compose.tls.yaml`, `deploy/nginx.conf`; trusted local TLS smoke with synthetic cert and credentials |

Полная регрессия также проверяет 100k-row file report/index/diff с ограничением heap96 MiB.
Новые календарные запросы семантически валидируются; invalid legacy cron не запускается.
Схемы предыдущих profile/scan/checkpoint/report не переписаны; SchedulerState1.0 добавлен отдельно.

## Исправления и уточнения EPIC-09

- Pending slot валидируется вместе с project/scan identity; повреждённый snapshot
  не превращается в scan по произвольному ID. Уже опубликованный queue commit
  подтверждается без повторного enqueue, даже после рестарта.
- Retention сохраняет scan, пока scheduler не подтвердил его durable intent.
- Backup нормализует легитимные hardlink report aliases в независимые файлы;
  restore отвергает ссылки в backup artifact. Копирование ограничено буфером64 KiB.
- Auth sessions/rate state не попадают в backup, поэтому restore не возвращает старые сессии.
- TLS proxy не монтирует DATA_DIR. Неправильный SNI отвергается до HTTP; HTTP не публикуется.
- Scheduler выключен по умолчанию. Ни тесты, ни сборка не запускают реальные цели.

## Эксплуатационные границы

Оператор управляет production сертификатом/hostname, обновлением image/dependencies,
секретами и host-level egress firewall. Docker Compose bridge сам по себе не является
firewall от private networks. App Safe HTTP policy остаётся обязательной независимо от сети.
Fastify `trustProxy=false`: входящий X-Forwarded-For не меняет auth identity; за одним proxy
приложение делит throttle bucket между клиентами. nginx добавляет edge limit, а не заменяет app limit.

Backup требует остановки всех web/worker/CLI writers; `--offline` — явное утверждение
оператора, а не автоматическое доказательство остановки чужих процессов. DATA_DIR,
backup artifact и parent directories доверены против одновременного изменения тем же UID/root.
SHA256 обнаруживает повреждение; не является подписью недоверенного отправителя.
Шифрование/offsite storage/operator TLS certificate renewal здесь не автоматизированы.
Диск/inode monitoring и сохранение приватных резервных копий — задачи эксплуатации;
runbook задаёт действия при заполнении, но не обещает встроенный quota service.

Внешние сайты, реальные Entity Feed credentials и production TLS не использовались.
Проверки не подтверждают весь MVP/AC-01…28: полный двухсайтовый пилот и sign-off — EPIC-10.
Развёртывание, backup/recovery и второй сайт: [deployment.md](deployment.md).
