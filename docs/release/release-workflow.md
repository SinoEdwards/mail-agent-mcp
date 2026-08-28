# Disabled release workflow draft

This repository intentionally ships no active release workflow. Its independent
GitHub identity is SinoEdwards/mail-agent-mcp and its reserved MCP metadata name is
io.github.SinoEdwards/mail-agent-mcp.
It deliberately contains no publish command, OIDC write permission, tag creation,
GitHub Release creation, registry login, or repository write permission.

## Enablement prerequisites

Before creating an active workflow:

- obtain explicit maintainer approval for npm and MCP Registry publishing.
- revalidate npm package ownership and MCP Registry namespace rules.
- enable publishing only in a separately reviewed workflow with least privilege.

## Required validation

- npm ci
- npm test
- npm run build
- npm run lint
- git diff --check
- secret-free static scan
- npm pack --dry-run
- package, lock, and server version and name consistency
- strict semantic tag validation
