# Architecture decisions — EPIC-01

## ADR-001 — TypeScript workspaces
Accepted: Node.js LTS, TypeScript strict, npm workspaces, Fastify web shell, independent worker, Zod contracts. The web and worker share types but are independently runnable. No CMS dependency in core.

## ADR-002 — Data persistence
Accepted for future work: versioned JSON/JSONL files in /data; no SQL/Redis. EPIC-01 verifies the volume is writable but does **not** claim durable scanning, reporting, locks or progress recovery. Implement these in EPIC-04.

## ADR-003 — Deploy/security boundary
Until EPIC-07 provides auth, the web application MUST be bound to 127.0.0.1 on the Docker host; only / and health exist. No site URL input or outbound crawling until EPIC-02 SSRF protections pass. The worker health endpoint binds loopback in its container.

## ADR-004 — Schema and source policy
Version 1.0 Zod schemas define the initial ProjectConfig, EntityFeed, ScanManifest, UrlRecord, Finding. Host allowlists checked at config validation, but do not protect DNS/IP: such checks are deferred to EPIC-02. Never mistake config validation for SSRF security.

## Open issues before EPIC-02
- Choose a connection-bound HTTP client with verified DNS/IP policy to avoid DNS rebinding.
- Finalize handling of public vs explicit private trusted backend endpoints.
- Determine lock/seek/indexing strategy for 100,000+ URLs before EPIC-04.
- Configure CI-generated npm lockfile and verify network dependency availability.

## Scope disclaimer
No actual scanner, authenticated API, project CRUD or full UI in EPIC-01.
