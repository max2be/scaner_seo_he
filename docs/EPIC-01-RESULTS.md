# EPIC-01 — результаты первой итерации

## Реализовано
- AI Factory 2.19.0 отдельно от приложения, выбранные локальные навыки и project overrides.
- npm workspaces: contracts/core/sources/storage/reports; apps web/worker/ui.
- Zod + TS contracts: ProjectConfig, EntityFeed/Entity, ScanManifest, UrlRecord/HttpEvidence, Finding.
- Rule API, fail-closed Fastify skeleton, проверка файлового хранилища и graceful shutdown.
- React/Vite build skeleton, без пользовательских функций и публикации UI.
- Multi-stage image и Compose, non-root/read-only, shared /data, healthchecks, localhost bind.
- CI, unit/integration/runtime smoke, эксплуатационные инструкции и ADR.

## Проверки на 2026-10-15
| Проверка | Результат |
|---|---|
| npm ci --ignore-scripts (повторная установка) | pass |
| npm run lint | pass |
| npm run typecheck | pass, включая tests/UI |
| npm test | 44 passed, 2 test files; 0 failed/skipped |
| npm run build | pass, packages/web/worker/UI |
| npm run smoke | pass: web и worker, health200/private401/SIGTERM exit0 |
| npm audit --omit=dev | 0 известных уязвимостей на момент проверки |
| bash /workspace/install-hsi-environment.sh | pass, проверен сохраняемый install_script |
| node scripts/cloud-docker-build.mjs | pass, TLS и npm integrity включены |
| docker compose up -d --wait | оба сервиса healthy |
| Docker runtime | non-root, read-only /app, writable /data, health200/projects401 |
| git diff --check | pass |

CI workflow создан, но удалённый GitHub Actions run не запускался. Docker проверен
на текущей Linux машине; arm64 и benchmark 100k URL ещё не проверены.

## Исправления по результатам Docker-проверки
- BuildKit не разрешал локальное имя proxy. Build-only helper использует extra_hosts,
  network=host и публичный CA через временный BuildKit secret. TLS не отключался.
- Файлы checkout имели строгие права; runtime COPY теперь передаёт ownership node,
  чтобы процессы non-root могли прочитать сборку. После исправления health и probes прошли.

## Границы и уточнения
- Полный MVP не готов: crawler, durable scan lifecycle, SEO rules, отчёты, login и UI
  workflows предусмотрены EPIC-02…10. sources/reports пока только package entrypoints.
- AC-01 целого продукта включает UI, AC-04 — реальное сканирование. В M0 есть только
  runtime skeleton и двухсайтовые config fixtures; эти AC целиком не объявляются passed.
- Контракты не подменяют sanitizer PII/HTML и не обеспечивают DNS pinning.
- Backend public HTTPS; ожидаемый каталог 10k–100k URL подтверждён пользователем.
- Формат Entity Feed использует id по ТЗ; backend.allowedHosts обязателен как в fixture.
- Исходные PRD/ТЗ/backlog/coverage/examples не изменены.

## Следующий этап
EPIC-02: сначала transport policy и DNS/IP pinning с проверкой peer IP и TLS servername,
затем ручные redirects, ограничения тела/распаковки, timeout/rate/retry/circuit breaker,
robots. Перед любым crawler/GUI target entry должны пройти private IPv4/IPv6,
IPv4-mapped, DNS rebinding, cross-host redirects, timeout, 429 и gzip-bomb fixtures.
Публичный сайт пилота для этих тестов не нужен. Нагрузочный SLA на 100k пока неизвестен.

## Файлы
README.md обновлён. Ниже новые файлы этой итерации (включая vendored AI Factory skills).
Прежние Node.js/TypeScript/testing skills сохранены и в этот список не включены.

- `.agents/skills/aif-architecture/SKILL.md`
- `.agents/skills/aif-architecture/references/architecture.md`
- `.agents/skills/aif-plan/SKILL.md`
- `.agents/skills/aif-plan/references/EXAMPLES.md`
- `.agents/skills/aif-plan/references/TASK-FORMAT.md`
- `.agents/skills/aif-plan/references/ULTRA-FORMAT.md`
- `.agents/skills/aif-review/SKILL.md`
- `.agents/skills/aif-review/references/CHECK-MODE.md`
- `.agents/skills/aif-review/references/SEVERITY.md`
- `.agents/skills/aif-review/references/VALIDATOR.md`
- `.ai-factory.json`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/PLAN.md`
- `.ai-factory/RULES.md`
- `.ai-factory/config.yaml`
- `.ai-factory/skill-context/aif-plan/SKILL.md`
- `.ai-factory/skill-context/aif-review/SKILL.md`
- `.ai-factory/skill-review.json`
- `.dockerignore`
- `.github/workflows/ci.yml`
- `.gitignore`
- `.node-version`
- `.npmrc`
- `AGENTS.md`
- `apps/ui/index.html`
- `apps/ui/package.json`
- `apps/ui/src/main.tsx`
- `apps/ui/tsconfig.json`
- `apps/web/package.json`
- `apps/web/src/app.ts`
- `apps/web/src/main.ts`
- `apps/web/tsconfig.json`
- `apps/worker/package.json`
- `apps/worker/src/app.ts`
- `apps/worker/src/main.ts`
- `apps/worker/tsconfig.json`
- `deploy/.env.example`
- `deploy/Dockerfile`
- `deploy/compose.yaml`
- `docs/DECISIONS.md`
- `docs/EPIC-01-RESULTS.md`
- `docs/development.md`
- `docs/skill-security.md`
- `eslint.config.js`
- `package-lock.json`
- `package.json`
- `packages/contracts/package.json`
- `packages/contracts/src/common.ts`
- `packages/contracts/src/entity.ts`
- `packages/contracts/src/finding.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/project.ts`
- `packages/contracts/src/scan.ts`
- `packages/contracts/tsconfig.json`
- `packages/core/package.json`
- `packages/core/src/index.ts`
- `packages/core/tsconfig.json`
- `packages/reports/package.json`
- `packages/reports/src/index.ts`
- `packages/reports/tsconfig.json`
- `packages/sources/package.json`
- `packages/sources/src/index.ts`
- `packages/sources/tsconfig.json`
- `packages/storage/package.json`
- `packages/storage/src/index.ts`
- `packages/storage/tsconfig.json`
- `scripts/cloud-docker-build.mjs`
- `scripts/healthcheck.mjs`
- `scripts/smoke.mjs`
- `tests/contracts.test.ts`
- `tests/runtime.test.ts`
- `tsconfig.base.json`
- `tsconfig.json`
- `tsconfig.tests.json`
- `vitest.config.ts`

Всего новых файлов этой итерации: 76.
