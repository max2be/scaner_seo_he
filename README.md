# Headless SEO Inspector

Universal SEO diagnostic scanner for headless sites. **EPIC-01…06 implemented: skeleton, safe HTTP, discovery, durable scan lifecycle SEO rules, file reports and scan comparison.**

## Specifications

- [PRD](docs/01_PRD.md) — product requirements and MVP scope.
- [Technical specification](docs/02_TECH_SPEC_FOR_CODEX.md) — system architecture, contracts, security and acceptance criteria.
- [Codex backlog](docs/03_CODEX_BACKLOG.md) — phased development plan; start with EPIC-01.
- [SEO audit coverage](docs/04_AUDIT_COVERAGE.md) — mapping to reference SEO audit.
- [Example project profile](docs/examples/project.example.json).
- [Example API entity feed](docs/examples/entity-feed.example.json).

## Start development with Codex

Read the PRD and technical specification, then follow the backlog in order; EPIC-01…06 are implemented. Do not hard-code SABOSPORTS or Bitrix-specific assumptions.

The discovery CLI imports sitemap/feed URLs and crawls source HTML with safe HTTP. Durable queue/checkpoints, resume, project locks and retention are implemented; see [scan lifecycle and CLI](docs/durable-storage.md). Rule Engine and durable findings are implemented; see [SEO rules](docs/seo-rules.md). File reports, seek pagination and conservative scan comparison are implemented; see [reports and CLI](docs/reports.md). Authentication and UI workflows remain in the backlog. See [HTTP client](docs/http-client.md) and [discovery CLI](docs/discovery.md).

## Development

See [development runbook](docs/development.md), [architecture decisions](docs/DECISIONS.md), and [skill security review](docs/skill-security.md).

```bash
npm ci --ignore-scripts
npm run check
npm run smoke
```
