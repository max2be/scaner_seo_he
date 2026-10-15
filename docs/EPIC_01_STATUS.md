# EPIC-01 delivery and verification

Branch: `feat/epic-01-foundation`.

Delivered:
- npm workspace scaffolding for web/worker/ui and contracts/core/sources/storage/reports.
- Versioned Zod project, feed, manifest, URL, and finding schemas and contract tests.
- Minimal Fastify health endpoint, worker health endpoint.
- Docker multi-stage file and compose, loopback-only web exposure, non-root container.
- ESLint, Vitest, TypeScript, GitHub Actions and ADR notes.

Not delivered (intentionally): scanning, auth, real UI, data queue or report generation.

**Verification status:** Source committed; CI verification required. The authoring environment cannot download npm packages or run Docker. `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and Docker smoke must pass in GitHub Actions before acceptance. AC-01 is not yet proven by runtime smoke; AC-04 has schema fixtures only and cannot be considered end-to-end complete.

**Next:** review CI, repair any errors, then implement EPIC-02 in a separate branch.
