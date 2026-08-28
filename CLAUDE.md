# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

The full, agent-agnostic project guide — architecture, build/test commands,
security rules, and conventions — lives in **@AGENTS.md**. Read it first.

## Claude-specific notes

- This is an IMAP/SMTP **MCP server** (TypeScript, ESM). It uses **`imapflow`**
  for IMAP and **`nodemailer`** for SMTP. (It does **not** use `node-imap`.)
- On the hardened Windows Gmail/QQ paths, refresh tokens, OAuth client
  secrets, and QQ authorization codes live in Windows Credential Manager;
  `~/.imap-mcp/accounts.json` keeps only non-secret metadata and credential
  target references. The generic-provider compatibility path is legacy and
  may keep AES-encrypted passwords beside a local key under `~/.imap-mcp/`.
  All tools return JSON-formatted text.
- When adding an IMAP/SMTP operation:
  1. Implement it in the relevant service (`ImapService` / `SmtpService`).
  2. Expose it via the matching tool file in `src/tools/`.
  3. Keep tool names (`imap_*`) stable; write LLM-oriented `.describe()` text.
  4. Update types in `src/types/index.ts`, plus `README.md` and tests.
- Before committing `src/` changes: `npm run build && npm test` (keep it green).
- Follow the security rules in @AGENTS.md — no secret logging, no telemetry,
  no destructive mail ops without explicit guard logic.
