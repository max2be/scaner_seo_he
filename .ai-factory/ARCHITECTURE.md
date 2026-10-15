# Архитектура: модульное приложение, технические пакеты

## Обоснование
PRD уже задаёт file-only deployment и независимость сканирования от web-процесса.
Один npm workspaces monorepo, один versioned image, два процесса web/worker.
Микросервисы и брокер сообщений здесь не нужны. Это практическая адаптация
модульного подхода к пакетам, указанным в ТЗ, без искусственных DDD слоёв.

## Структура и зависимости
- packages/contracts: Zod схемы, выведенные TS типы, schemaVersion=1.0, без I/O.
- packages/core: Rule API, доменные правила; зависит только от contracts.
- packages/sources: discovery/adapters; contracts/core, без web/React.
- packages/storage: файловые адаптеры, contracts; не зависит от web.
- packages/reports: представления и diff, contracts/core; не зависит от UI.
- apps/worker: composition root pipeline, единственный writer scan journals.
- apps/web: Fastify, приватные API, статическая UI-сборка; без запуска crawler в HTTP handler.
- apps/ui: React, API DTO из contracts; запрещены node:fs/storage/worker imports.
Другие пакеты импортируются только по публичному имени @hsi/*; циклы запрещены.
Правила живут в core, HTTP и file I/O подключаются адаптерами.

## Решения и границы
См. docs/DECISIONS.md. Версии фиксирует package-lock.json, Node major — .node-version.
Runtime-валидация на входах API/feed и чтении файлов обязательна. Неизвестные поля
конфигурации отклоняются, чтобы опечатки в safety settings не игнорировались.
Стабильные ID не включают scanId; ошибки источника не являются SEO находками.
100k URL: append-only JSONL + checkpoint offsets, постраничный индекс с seek,
bounded buffers; запрещено читать весь каталог/HTML в web process.

## Security gates
EPIC-01 предоставляет только общедоступный минимальный health endpoint.
EPIC-07: health публичен, login требует Origin/rate limit, остальные API требуют admin session.
Writes требуют Origin/CSRF, download/file paths закрыты. Без auth config private routes401.
UI функции — EPIC-08; UI skeleton собирается, но не публикуется. См. docs/api-auth.md.
Никаких HTTP requests к пользовательским URL до EPIC-02: DNS resolve + public IP
policy IPv4/IPv6 + connection-bound pinning + повторная проверка редиректов + TLS.
Private backend не включён. Это открытый вопрос пилота, не разрешение SSRF bypass.
