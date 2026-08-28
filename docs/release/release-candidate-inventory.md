# Release-candidate inventory

This file classifies the v0.1.0 Public Preview source-release surface for SinoEdwards/mail-agent-mcp.

## Source

- src/credentials: Credential Manager, enrollment, repair, OAuth, proxy transport.
- src/services: account, IMAP/SMTP, safe-send, spam services.
- src/tools and src/utils: MCP contracts, safe-send tools, attachment boundary.
- build.mjs and public: application build and optional loopback-only setup UI.

## Tests

- Unit and mock integration tests under tests.
- No real provider credential is permitted in a test, fixture, snapshot, or CI secret.
- Real-provider checks use docs/release/provider-smoke-checklist.md and remain outside public CI.

## Documentation

- README.md, SECURITY.md, CONTRIBUTING.md, AGENTS.md, CHANGELOG.md.
- docs/agent-integration.md for machine-readable MCP boundaries.
- docs/release for disabled release design, registry template, and smoke evidence.

## Workflows

- .github/workflows/ci.yml is the only active workflow and has contents:read.
- .github/workflow-drafts/release.yml is intentionally inactive and contains no publish step.
- Automated merge and AI review workflows with write credentials are excluded.

## Generated and local-only

- dist, coverage, reports, package tarballs, logs, .env files, OAuth downloads, accounts.json, .key, and credential exports are ignored and must not be committed.
- docs/superpowers contains local design/implementation notes and is not part of the package tarball.
- server.json contains the confirmed GitHub/MCP identity but does not authorize or trigger registry publication.

## Known compatibility surface

- Exact legacy CodexLab Credential Manager targets remain readable; new writes use MailAgentMCP targets.
- Existing generic IMAP/SMTP AES records remain readable. This legacy path is not equivalent to an OS vault and is documented as such.
- Existing .imap-mcp configuration and IMAP_MCP_* environment names remain for compatibility and are not publication identity.
