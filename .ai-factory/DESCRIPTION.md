# Headless SEO Inspector
Самодостаточный private сервис анализа исходного HTTP/HTML любых headless-сайтов.
Источник требований: docs/01_PRD.md, docs/02_TECH_SPEC_FOR_CODEX.md,
docs/03_CODEX_BACKLOG.md, docs/04_AUDIT_COVERAGE.md.
Node.js 24 LTS, TypeScript, Fastify, React/Vite, Zod, Vitest, Docker Compose.
Только JSON/JSONL/CSV/HTML, без БД, Redis и внешних SaaS. JS целевых сайтов не исполняется.
Реализованы EPIC-01…09: skeleton, HTTP security, discovery, durable scan lifecycle/locks/resume/retention, Rule Engine/SEO facts, reports/diff, auth/API и защищённая русская SPA с browser tests, cron/timezone scheduler, TLS overlay и offline backup/restore.
Архитектура: модульное приложение с двумя процессами и техническими пакетами;
правила зависимостей в .ai-factory/ARCHITECTURE.md.

EPIC-10 добавляет two-site disposable acceptance demo, AC matrix, generated pipeline load
и pilot runbook. SSR shell1.0.1 охватывает standalone без бизнес-догадок. Production pilot
остаётся опциональным и требует отдельного разрешения владельца.
Полный повтор100k pipeline после bounded cleanup fix отложен после уточнения пользователя
о достаточности тестов; он не засчитывается успешным. Результаты: docs/EPIC-10-RESULTS.md.
