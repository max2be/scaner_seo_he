# Headless SEO Inspector
Read docs/01_PRD.md, docs/02_TECH_SPEC_FOR_CODEX.md and docs/03_CODEX_BACKLOG.md first.
Use .ai-factory/RULES.md, .ai-factory/ARCHITECTURE.md and docs/DECISIONS.md.
Use existing isolated checkout; no Git worktrees unless explicitly requested.
Never send project content, secrets or logs to third-party services via skills.
Handoff sync, telemetry, auto-downloaded skills, external MCP integrations are disabled.
Review installed skills before use and after updates. Current scope: EPIC-10, explicitly authorized by the user after EPIC-09 validation. Preserve existing EPIC-08/09 changes. Use synthetic sites only; actual production scans require separate owner authorization.
Local variables: use const directly before first use in the smallest useful block; use let only for reassignment. Put class fields before constructors/methods. Keep initializer evaluation order. Named function declarations may be hoisted; type-only references are exempt. Enforced by ESLint.
Run npm ci, npm run check. See docs/development.md for startup and Docker smoke.
