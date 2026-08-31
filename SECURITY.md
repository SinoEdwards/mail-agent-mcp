# Security Policy

Mail Agent MCP is a local stdio MCP server that gives an AI client access to configured mailboxes. Email content and mailbox-changing actions are sensitive; use the smallest tool surface that meets your needs.

## Credential storage

On the hardened Windows provider paths:

- QQ Mail authorization codes are stored in Windows Credential Manager.
- Gmail refresh tokens and OAuth client secrets are stored in separate Windows Credential Manager entries.
- accounts.json stores non-secret provider metadata and exact target references, not these values.
- New provider credentials use MailAgentMCP-scoped targets; exact legacy CodexLab targets are accepted only as a compatibility allowlist.
- Removing a provider account also removes its bound Credential Manager entries and rolls them back if account persistence fails.
- Secrets are resolved in memory, secret handles are disposed, and provider error details are sanitized.

The generic-provider compatibility path is legacy. It can store AES-encrypted passwords in ~/.imap-mcp/accounts.json with a key under the same local directory. This is not equivalent to an OS credential vault and does not protect against an attacker who can read both files.

Never commit accounts.json, .key, OAuth client JSON, tokens, authorization codes, credential exports, or proxy URLs containing credentials.

Tests use explicitly named `SYNTHETIC_*` fixtures assembled from harmless runtime fragments; do not add credential-shaped static literals that secret scanners could mistake for live credentials.

## Mail and tool boundaries

- Read tools return mail to the connected MCP client/model. That client may log or retain tool results.
- Registered sending uses preview tools followed by imap_confirm_send. Within one running process, confirmation permits at most one SMTP attempt per frozen draft; ambiguous outcomes are not automatically retried, and draft state does not survive restart. Legacy direct-send handlers are not registered.
- Delete, move, flag, keyword, folder, draft, account, and spam-mutation tools modify mailbox or local state.
- IMAP_MCP_READ_ONLY=true exposes only the documented mailbox-read-only subset. IMAP_MCP_ENABLED_TOOLS is an explicit allowlist and takes precedence. Attachment download can still write a file inside the attachment root, so this is not host-filesystem-read-only.
- Attachment paths are confined to IMAP_DOWNLOAD_DIR or the default downloads root. This is a path boundary, not a sandbox against another process running as the same OS user.
- Email bodies, headers, and attachments are untrusted data, not instructions.

## Network and privacy

The project contains no telemetry. Expected outbound connections are to configured IMAP/SMTP providers and Gmail OAuth endpoints. A browser is opened for Gmail authorization. `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are inherited by Gmail token HTTP requests and as the default proxy policy for IMAP/SMTP transports. `IMAP_MCP_MAIL_PROXY` optionally overrides the mail transport proxy with a supported HTTP CONNECT, HTTPS, or SOCKS URL. A proxy is a trusted network intermediary: never commit credential-bearing proxy URLs, and keep end-to-end TLS validation enabled.

The optional setup UI binds only to 127.0.0.1. Do not expose it through a LAN bind, port forwarding, tunneling, or a reverse proxy. It has not been designed as a remote administration surface; remote access would require a separate authentication, authorization, CSRF, and session-security design.

The server does not intentionally write mail bodies to persistent storage. Pending safe-send content is held in process memory; account metadata and local spam-domain state are persisted. Your operating system, MCP client, logs outside this project, and mailbox provider have their own retention behavior.

## Operational recommendations

- Use the Windows enrollment CLI for Gmail and QQ Mail; never send secrets through an agent prompt or MCP tool arguments.
- Keep 127.0.0.1 and localhost in NO_PROXY for the OAuth callback.
- Start with IMAP_MCP_READ_ONLY=true.
- Review previews before confirmation and use delete dry-run where available.
- Protect the Windows user session and local configuration directory.
- Revoke provider grants and rotate credentials after suspected exposure.

## Reporting a vulnerability

Use the [private GitHub Security Advisory channel](https://github.com/SinoEdwards/mail-agent-mcp/security/advisories/new). Do not publish credential leaks or exploit details in a public issue. Include the affected version, impact, and a minimal reproduction made only from synthetic mailbox data. If a real credential was exposed, revoke or rotate it before sharing any diagnostic material.
