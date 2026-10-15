# EPIC-01 delivery and verification

Branch: `feat/epic-01-foundation`.

Delivered:
- npm workspace scaffolding for web/worker/ui and contracts/core/sources/storage/reports.
- Versioned Zod project, feed, manifest, URL, and finding schemas and contract tests.
- Minimal Fastify health endpoint and worker health endpoint.
- Docker multi-stage image and Compose; host loopback-only web binding; non-root container.
- ESLint, Vitest, TypeScript, GitHub Actions and ADR notes.

Not delivered (intentionally): site scanner, authentication, production UI, scan queues or reports.

**Verification status:** code uploaded; no local npm/Docker execution possible (npm registry unavailable and Docker absent). The initial CI runs `npm install` to generate dependencies; this is a temporary bootstrap measure. Review CI results, generate and commit `package-lock.json`, then switch CI/Docker to `npm ci` before treating EPIC-01 as complete. Also run Docker runtime smoke (both service health checks), not just image build. AC-01 and AC-04 are **not yet fully proven**.

**Next:** close CI findings and lockfile, then implement EPIC-02 security-oriented HTTP fetcher as an independent change.
