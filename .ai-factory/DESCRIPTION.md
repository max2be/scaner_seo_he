# Headless SEO Inspector
Самодостаточный private сервис анализа исходного HTTP/HTML любых headless-сайтов.
Источник требований: docs/01_PRD.md, docs/02_TECH_SPEC_FOR_CODEX.md,
docs/03_CODEX_BACKLOG.md, docs/04_AUDIT_COVERAGE.md.
Node.js 24 LTS, TypeScript, Fastify, React/Vite, Zod, Vitest, Docker Compose.
Только JSON/JSONL/CSV/HTML, без БД, Redis и внешних SaaS. JS целевых сайтов не исполняется.
Реализованы EPIC-01…07: skeleton, HTTP security, discovery, durable scan lifecycle/locks/resume/retention. Rule Engine/SEO facts/findings реализованы; reports/diff реализованы; auth/API реализованы; UI ещё не реализован.
Архитектура: модульное приложение с двумя процессами и техническими пакетами;
правила зависимостей в .ai-factory/ARCHITECTURE.md.
