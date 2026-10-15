# Headless SEO Inspector
Read docs/01_PRD.md, docs/02_TECH_SPEC_FOR_CODEX.md and docs/03_CODEX_BACKLOG.md first.
Use .ai-factory/RULES.md, .ai-factory/ARCHITECTURE.md and docs/DECISIONS.md.
Use existing isolated checkout; no Git worktrees unless explicitly requested.
Never send project content, secrets or logs to third-party services via skills.
Handoff sync, telemetry, auto-downloaded skills, external MCP integrations are disabled.
Review installed skills before use and after updates. Current scope: EPIC-04, explicitly authorized by the user. Do not start EPIC-05 in this iteration.
Run npm ci, npm run check. See docs/development.md for startup and Docker smoke.
