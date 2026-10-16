# Частное развёртывание и эксплуатация — EPIC-09

Linux, Docker Engine/Compose v2, локальный writable volume; NFS/несколько машин не поддержаны.
Сначала выполните `npm ci --ignore-scripts && npm run check && npm run test:e2e` или CI.
Production скан допускается только с разрешения владельца и согласованными allowlist/лимитами.
Тесты/примеры этого репозитория не являются разрешением сканировать указанные домены.

## Установка с HTTPS

1. Скопируйте `.env.example` в приватный env-файл вне Git, права0600. Используйте Node24.19.0.
   Сгенерируйте собственный Argon2id PHC через stdin helper по [api-auth.md](api-auth.md).
   В env задайте `ADMIN_PASSWORD_HASH`, точный `PUBLIC_ORIGIN=https://ваш-домен` и
   `JOB_CONCURRENCY=2`. Не передавайте пароль в argv/URL и не публикуйте env в чате.
2. Подготовьте сертификат с полной цепочкой и ключ для этого домена. Укажите абсолютные
   `HSI_TLS_CERT_FILE` / `HSI_TLS_KEY_FILE`. Файлы должны существовать и быть доступны
   на чтение UID1000; ключ рекомендуется0400, каталог0700. Сертификаты не копируются
   в production image. Получение/обновление сертификата — задача оператора; внешнего
   ACME сервиса или отправки секретов приложением нет. Synthetic test key использовать нельзя.
3. В своей копии `deploy/nginx.conf` замените `inspector.example.com` на hostname
   из PUBLIC_ORIGIN; задайте `HSI_TLS_CONFIG_FILE` абсолютным путём к этой копии.
   Не используйте произвольный Host как адрес редиректа. Неизвестный SNI отклоняется.
4. Настройте DNS и firewall. По умолчанию443 также привязан к127.0.0.1. Для доступа
   через публичный интерфейс оператор явно задаёт `HSI_TLS_BIND=0.0.0.0` либо нужный IP,
   ограничивая доступ VPN/firewall. Прямой3000 остаётся loopback; worker порт не публикуется.
5. Загрузите env безопасным способом в свой shell/Compose. Укажите путь явно:

```bash
docker compose --env-file /private/hsi.env -f deploy/compose.yaml -f deploy/compose.tls.yaml config --quiet
docker compose --env-file /private/hsi.env -f deploy/compose.yaml -f deploy/compose.tls.yaml up -d --build --wait
```

Overlay требует admin hash/origin/cert/key и не стартует с отсутствующей конфигурацией.
Базовый Compose без TLS подходит для закрытой диагностики: health работает, private API401,
login503 без admin. Это не вариант публикации обычного HTTP для входа из браузера.
Cloud build adapter описан в [development.md](development.md); не отключайте проверку TLS/npm integrity.

После запуска проверьте свой HTTPS origin: shell200, health200, anonymous `/api/projects`401,
затем login/logout, private export и cookie Secure/HttpOnly/SameSite=Strict. Нельзя подменять
доверие к production certificate флагами insecure/ignoreHTTPSErrors. Проверьте срок сертификата
и обновляйте его с перезагрузкой proxy. Для локальных тестов доверяется только test certificate.

## Proxy и границы доверия

Nginx закреплён digest в `compose.tls.yaml`, работает UID1000, read-only, без capabilities
и DATA_DIR, с tmpfs64MiB. Не монтируйте ему Docker socket или каталог результатов.
TLS1.2/1.3, session tickets off, HSTS1year, nosniff; CSP/Frame/Referrer policy задаёт web.
Лимит тела1MiB, headers/body15s, connect5s, send15s, read/send inactivity60s,20 соединений/IP.
Буферизация exports выключена; proxy timeout не ограничивает общую длину потокового отчёта.
Login имеет дополнительный burst/rate limit с безопасным JSON429; основной persistent limiter
остаётся в приложении. Access log выключен, error log только crit, без request bodies/cookies.

Cookie и Origin передаются без замены. X-Forwarded-For перезаписывается адресом клиента,
но Fastify сохраняет trustProxy=false: все клиенты разделяют bucket proxy. Это сознательный
single-admin default, не механизм получения реальных IP через недоверенный заголовок.
Общий NAT/proxy bucket может ограничить легитимные повторные входы — дождитесь Retry-After.

SafeHttpClient отдельно проверяет hostname и все A/AAAA адреса, закрепляет IP подключения,
проверяет TLS и каждый redirect. HTTP_PROXY build-среды не становится crawler proxy.
Private backend не включён; публичный HTTPS feed имеет отдельный allowlist/origin binding.
Дополнительно оператор ограничивает egress контейнеров firewall согласно своим DNS/CDN/API.
Compose сам по себе не предоставляет firewall allowlist; это не заявляется выполненным
сетевым ограничением конкретной инсталляции. Никогда не разрешайте metadata/private ranges.

## Расписания

В проекте задаются `scanSchedule.cron` и `timezone`; UI позволяет включить/изменить/отключить.
Пять **числовых** полей: минута, час, день месяца, месяц, день недели; поддержаны `*`, списки,
диапазоны и шаги. Пример `0 3 * * *`, `Europe/Moscow`. Нет секунд, @aliases, имён месяцев,
H/L/# расширений. API отклоняет новые некорректные значения. Старый ProjectConfig1.0
остаётся читаемым; invalid legacy cron отключает только расписание этого проекта.
PATCH `{scanSchedule:null}` удаляет расписание, не вводя null в хранимый ProjectConfig.

Оператор отдельно включает `SCHEDULER_ENABLED=true` только после разрешения автоматических
сканов. `SCHEDULER_CATCH_UP=true` по умолчанию; false пропускает исторические missed slots.
Интервал15s; при запуске напрямую `SCHEDULER_INTERVAL_MS` можно задать1000…60000.
Не меняйте JOB_CONCURRENCY независимо на web/worker: он должен совпадать с сохранённым pool.

- Первый enable/изменение конфигурации начинается с текущей минуты, не запускает прошлые дни.
- После downtime выбирается только последний missed slot, не цепочка сканов за всё время.
- Slot хранится в UTC. Во время весеннего DST отсутствующее wall time пропускается;
  повторяющийся осенью local minute имеет два разных UTC slot, если проект свободен.
- При clock rollback watermark не откатывается и старые slots не повторяются.
- Project flock и durable operations исключают overlap с manual scan; глобальный pool
  ограничивает worker execution, очередь может содержать разные проекты.
- Занятый/архивный проект не запускается параллельно. Pending intent и deterministic scan ID
  переживают crash до/после публикации queue directory; retention защищает unacknowledged scan.
- Новая версия state1.0 — `projects/ID/scheduler.json`. Повреждённый state не сбрасывается
  автоматически ради запуска: scheduler выдаёт безопасный код и продолжает другие проекты.

`GET /api/projects/ID/schedule` возвращает последний committed snapshot; это не live worker
heartbeat. UI явно отмечает это. Проверяйте `lastCheckedAt` и реальные manifests/operations;
устаревший timestamp означает необходимость диагностики worker/clock/config/permissions.
Не удаляйте watermark для «починки» без анализа: это может изменить семантику catch-up.

## Backup и восстановление

Backup — приватная локальная директория, не публичный attachment. Она содержит ProjectConfig,
сканы, checkpoints, scheduler state и reports, но **не root auth/** (сессии/rate state).
Настоящие ENV/docker secrets и TLS keys должны храниться отдельно и не находиться в DATA_DIR.
При переносе backup используйте защищённое хранилище/шифрование по правилам оператора.
Никакой отправки backup во внешние сервисы эти команды не выполняют.

**Остановите всех writers: web, worker и отдельные CLI.** Флаг `--offline` подтверждает
это действие оператора, не доказывает отсутствие чужого процесса автоматически. Live snapshot
и согласованность во время параллельной записи не поддерживаются; файл, изменившийся
при копировании, приводит к ошибке. Не объявляйте такую ошибку успешным backup.
Proxy может оставаться запущенным, но API временно недоступен.

```bash
docker compose --env-file /private/hsi.env -f deploy/compose.yaml stop inspector-web inspector-worker
# /private/hsi-backups принадлежит UID1000 и имеет0700; выбирайте НОВОЕ имя snapshot.
docker compose --env-file /private/hsi.env -f deploy/compose.yaml run --rm --no-deps \
  -v /private/hsi-backups:/backups inspector-worker \
  node apps/worker/dist/backup.js create --offline --source /data --target /backups/maintenance-01
```

Если HSI_DATA_DIR изменён, передайте его действующий путь вместо `/data`. Backup destination
обязан быть вне source DATA_DIR и не существовать; повтор не перезаписывает старый snapshot.
Формат: `backup.json`, bounded `files.jsonl` (path/bytes/SHA256) и `payload/`. Директории0700,
файлы0600; потоковое копирование64KiB. Symlinks/special files запрещены. Легитимные hardlink
aliases отчётов копируются как независимые файлы; artifact/restore hardlinks не допускает.
Незавершённый staging не публикуется как готовый target.

Обязательно проверяйте восстановление на **новый**, несуществующий каталог, без удаления
старых данных. Например, из того же mount во временно остановленной инсталляции:

```bash
docker compose --env-file /private/hsi.env -f deploy/compose.yaml run --rm --no-deps \
  -v /private/hsi-backups:/backups:ro inspector-worker \
  node apps/worker/dist/backup.js restore --offline --source /backups/maintenance-01 --target /data/restored-01
```

Restore проверяет manifest checksum, пути, каждый payload hash/size и totals до публикации.
Коррупция, path traversal, symlinks, duplicate records и существующий target отклоняются.
После успеха задайте `HSI_DATA_DIR=/data/restored-01` **для обоих** сервисов и запустите Compose.
Старый `/data` сохраняется. После rollback-восстановления по более старому backup результаты
соответствуют его времени; old browser sessions не восстанавливаются, понадобится новый login.
Pending queue/checkpoints сохраняются; при worker restart проверяйте interrupted/resume.
Прежде чем включать SCHEDULER_ENABLED после restore, проверьте ожидаемый catch-up и часы.
Никогда не используйте `down -v` для обслуживания пользовательского volume.

## Диск, retention и диагностика

Перед backup, full scan и Docker build проверьте свободное место/inodes (`df -h`, `df -i`).
Рекомендуется операторский alert по диску, например20% свободного места; это рекомендация,
не встроенный quota manager. HTML/JSONL/indexes и backup требуют отдельного запаса.
При ENOSPC остановите новые задания, сохраните исходный volume, освободите только известные
воспроизводимые build caches или архивы по согласованной retention policy. Не удаляйте
checkpoints, активные/pinned/interrupted scans или user volumes ради зелёного health.

Retention CLI описан в [durable-storage.md](durable-storage.md): архивирование до удаления,
проверка совпадения существующего архива, keepLastRuns и защита pending schedule scan.
Никакого автоматического удаления результатов без указанного archive destination не добавлено.

Порядок проверки проблем: health → worker process/permissions → manifest/operation state →
source diagnostics → TLS/Origin/cookie/CSRF. Не печатайте env/compose config с hash/секретами,
не включайте debug/access logging тел запросов. Ошибка backend/robots не является SEO404.
`nginx -t` проверяет конфигурацию, а реальный TLS health/login нужен отдельно после reload.

## Второй headless-сайт и Entity Feed

1. Используйте [project-second.example.json](examples/project-second.example.json) как
   самостоятельный сайт без backend, либо настройте Entity Feed по
   [entity-feed.example.json](examples/entity-feed.example.json). Код HSI не меняется.
2. Замените id/name/baseUrl/allowedHosts/canonical policy, seeds/sitemap и лимиты на согласованные.
   Начните с1req/s/host, concurrency2, maxUrls100000; сначала ограниченная source validation.
3. Для backend используйте публичный HTTPS endpoint и отдельный backend.allowedHosts.
   Чужой CMS API преобразуйте отдельным read-only adapter в Entity Feed v1. Не подключайте БД.
4. Задайте read-only token только worker, а web — лишь `BACKEND_CREDENTIAL_ORIGINS` с именем ENV
   и точным HTTPS origin. Пример безопасного overlay, без токена в файле:

```yaml
services:
  inspector-worker:
    environment:
      SECOND_FEED_TOKEN: ${SECOND_FEED_TOKEN:?Set privately for worker only}
```

Config содержит `auth:{type:"bearer",tokenEnv:"SECOND_FEED_TOKEN"}`, а web mapping —
`{"SECOND_FEED_TOKEN":["https://feed.example.org"]}`. PUBLIC_ORIGIN/ADMIN hash worker не нужны.
Смена backend origin требует нового binding; перенаправлять bearer на другой origin нельзя.
Стабильный snapshotId, cursor/nextCursor и publicationState обязательны для достоверных выводов.
5. Через панель сохраните/проверьте профиль, затем выполните owner-approved scan. Проверьте
   incomplete/reasons и exports; только затем включайте расписание. Не считайте preflight
   доказательством полного feed/catalog и не угадывайте ожидаемые200 для unpublished/deleted.

## Локальная приёмка deployment sample

`node scripts/smoke-tls.mjs` после сборки образа запускает отдельные nonroot web+nginx,
временную Docker network, loopback TLS port и синтетические credentials/certificate.
Проверяет доверенный TLS/SNI, health/UI/assets, private401, secure session/CSRF/logout,
лимит тела и security headers. Production volume/env не используются, ресурсы fixture удаляются.
`smoke-backup.mjs` проверяет file snapshot/restore в production image на synthetic DATA_DIR.
Всё это дополняет Chromium E2E только собственного UI и существующие security suites.
