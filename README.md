# Headless SEO Inspector

Universal SEO diagnostic scanner for headless sites. **EPIC-01…09 implemented; EPIC-10 acceptance tooling added: skeleton, safe HTTP, discovery, durable scan lifecycle, SEO rules, file reports, scan comparison, authenticated API, Russian web UI, cron scheduler and deployment/backup tooling.**

## Specifications

- [PRD](docs/01_PRD.md) — product requirements and MVP scope.
- [Technical specification](docs/02_TECH_SPEC_FOR_CODEX.md) — system architecture, contracts, security and acceptance criteria.
- [Codex backlog](docs/03_CODEX_BACKLOG.md) — phased development plan; start with EPIC-01.
- [SEO audit coverage](docs/04_AUDIT_COVERAGE.md) — mapping to reference SEO audit.
- [Example project profile](docs/examples/project.example.json).
- [Example API entity feed](docs/examples/entity-feed.example.json).

## Start development with Codex

Read the PRD and technical specification, then follow the backlog in order; EPIC-01…09 are implemented. Do not hard-code SABOSPORTS or Bitrix-specific assumptions.

The discovery CLI imports sitemap/feed URLs and crawls source HTML with safe HTTP. Durable queue/checkpoints, resume, project locks and retention are implemented; see [scan lifecycle and CLI](docs/durable-storage.md). Rule Engine and durable findings are implemented; see [SEO rules](docs/seo-rules.md). File reports, seek pagination and conservative scan comparison are implemented; see [reports and CLI](docs/reports.md). Authenticated API is implemented; see [auth and API setup](docs/api-auth.md). The [web UI](docs/web-ui.md) provides projects, scan progress, findings/evidence and comparison; configure admin credentials and HTTPS before browser access. See [HTTP client](docs/http-client.md) and [discovery CLI](docs/discovery.md).

Operations: [TLS, scheduler, offline backup/restore and second-site onboarding](docs/deployment.md).
Security: [EPIC-09 review](docs/EPIC-09-SECURITY-REVIEW.md).

Acceptance: [AC-01…28 matrix](docs/ACCEPTANCE-MATRIX.md), [two-site demo and pilot procedure](docs/pilot.md).
After build: `npm run demo`; explicit load: `npm run benchmark:pipeline`.
EPIC-10 [results and open load gate](docs/EPIC-10-RESULTS.md): full 10k pipeline passed;
the 100k repeat after cleanup fix was stopped before completion and remains unverified.

## Development

See [development runbook](docs/development.md), [architecture decisions](docs/DECISIONS.md), and [skill security review](docs/skill-security.md).

EPIC-09 results: [scheduler and deployment acceptance](docs/EPIC-09-RESULTS.md).

EPIC-08 results: [UI acceptance](docs/EPIC-08-RESULTS.md).

EPIC-01…07 branch consolidation and verification: [sum1-7 results](docs/SUM1-7-RESULTS.md).

```bash
npm ci --ignore-scripts
npm run check
npm run smoke
npx playwright install --with-deps chromium
npm run test:e2e
```
