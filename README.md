# Mail Agent MCP

[![CI](https://github.com/SinoEdwards/mail-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SinoEdwards/mail-agent-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.12](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
![Status: Public Preview](https://img.shields.io/badge/status-public_preview-orange.svg)

Mail Agent MCP is a local-first TypeScript stdio MCP server that gives AI agents a controlled Gmail and QQ Mail interface for IMAP search/read/organization, attachments, and preview-confirmed SMTP sending.

Gmail uses OAuth 2.0; QQ Mail uses provider authorization codes. On Windows, provider secrets stay in Windows Credential Manager instead of account JSON.

> Release status: v0.1.1 Public Preview / Beta. Install from this GitHub repository; the package is not published to npm or the MCP Registry.

## Features

- Gmail OAuth 2.0 installed-app enrollment with PKCE, state validation, refresh-token support, and sanitized provider errors.
- QQ Mail IMAP/SMTP enrollment with hidden authorization-code input and rollback-safe credential repair.
- IMAP search, read, recent mail, folders, flags, keywords, move, guarded delete, drafts, and attachments.
- Gmail HTTPS API tools for labels, search, metadata, bounded text/Markdown bodies, and bounded attachment downloads when Gmail IMAP is unavailable.
- Preview-confirmed sending, including Gmail API-ID reply/forward previews when Gmail IMAP is unavailable.
- Read-only mode and explicit MCP tool allowlists.
- Attachment path confinement with a configurable local root.
- Local stdio transport; no hosted service and no telemetry in project code.

## Supported providers

| Provider | Authentication | Receive | Send | Enrollment |
| --- | --- | --- | --- | --- |
| Gmail / Google Workspace | OAuth 2.0 desktop client, PKCE, refresh token | Gmail API read tools or IMAP | SMTP OAuth2; Gmail saves its own Sent copy, so no IMAP append by default | Windows CLI |
| QQ Mail | QQ authorization code | IMAP | SMTP | Windows CLI |
| Other IMAP/SMTP providers | Legacy password/app-password account path | IMAP | SMTP | Legacy tools/web setup |

The hardened Credential Manager enrollment path is currently Windows-only. Generic-provider compatibility remains available, but its legacy password store is not equivalent to Windows Credential Manager; see Security model.

## MCP tools

The server exposes 48 tools in full mode. Existing tools use the `imap_` prefix; Gmail HTTPS tools use `gmail_api_`.

- Accounts: imap_add_account, imap_update_account, imap_list_accounts, imap_remove_account, imap_connect, imap_disconnect, imap_test_account.
- Read/search: imap_search_emails, imap_get_email, imap_get_latest_emails, imap_find_thread_messages, imap_find_email_by_message_id.
- Gmail HTTPS read: gmail_api_list_labels, gmail_api_search_messages, gmail_api_get_message, gmail_api_list_attachments, gmail_api_download_attachment. Gmail API string IDs must never be passed as IMAP UIDs. Message bodies are bounded text or Markdown; attachment downloads are limited to 5 MiB per file and saved only inside the configured root.
- Folders and state: imap_list_folders, imap_folder_status, imap_create_folder, imap_get_unread_count, mark/read, flags, keywords, move and guarded delete tools.
- Attachments and drafts: imap_upload_file, imap_download_attachment, imap_save_draft.
- Safe sending: imap_preview_send_email, imap_preview_reply_to_email, imap_preview_forward_email, gmail_api_preview_reply_to_message, gmail_api_preview_forward_message, imap_confirm_send. The Gmail API previews read by opaque API ID; they do not send and are hidden in read-only mode.
- Spam helpers: inspection, domain lists, and explicitly enabled mutation tools.

imap_send_email, imap_reply_to_email, and imap_forward_email are legacy handlers and are never registered. Sending requires a server-side frozen preview and a separate imap_confirm_send call with confirmed: true. See docs/agent-integration.md for a machine-readable contract and read/write boundaries.

## Quick start

Requirements: Windows 10/11 and Node.js 22.12 or newer for hardened Gmail/QQ enrollment.

1. Clone the repository and enter it:

   ```powershell
   git clone https://github.com/SinoEdwards/mail-agent-mcp.git
   Set-Location mail-agent-mcp
   ```

2. Install locked dependencies and build:

   ```powershell
   npm ci
   npm run build
   ```

3. Check the enrollment commands:

   ```powershell
   node dist/enroll.js --help
   ```

4. Enroll at least one provider in an interactive PowerShell terminal:

   ```powershell
   node dist/enroll.js gmail
   node dist/enroll.js qq
   ```

5. Register the local build with Codex CLI:

   ```powershell
   codex mcp add mail-agent -- node "$PWD\dist\index.js"
   codex mcp list
   ```

For read-only discovery:

```powershell
codex mcp add --env IMAP_MCP_READ_ONLY=true mail-agent-readonly -- node "$PWD\dist\index.js"
```

For other MCP clients, configure a stdio server whose command is node and whose only argument is the absolute path to dist/index.js. Do not copy author-specific paths.
## Gmail setup

1. In Google Cloud Console, create or select a project and enable the Gmail API.
2. Configure the OAuth consent screen. In Testing mode, add the Gmail address as a test user; Google may reject users who are not listed.
3. Create an OAuth client of type Desktop app. Copy its client ID and client secret.
4. Run node dist/enroll.js gmail in an interactive Windows terminal.
5. Enter the Gmail address, local account name, client ID, and client secret when prompted. The secret prompt is hidden.
6. Complete the browser consent flow. The callback binds to a random 127.0.0.1 port and the same redirect URI and PKCE verifier are used for token exchange.

The refresh token and client secret are stored under provider/account-bound Windows Credential Manager targets. accounts.json stores only non-secret metadata and target references. Gmail never falls back to password authentication.

Reauthorization: run node dist/enroll.js gmail-repair ACCOUNT_ID_OR_NAME. It obtains a fresh refresh token through browser OAuth, verifies authentication without reading mail, and restores the previous credential if verification fails.

Common failures:

- OAuth test user rejected: add the account under OAuth consent-screen test users or publish the app according to Google's rules.
- client_secret_required: use the client secret belonging to the same Desktop client ID.
- invalid_grant: restart enrollment; authorization codes are single-use and expire.
- no refresh token: revoke the app grant if necessary, then rerun consent with offline access.
- token refresh fails: verify proxy connectivity, client configuration, and that the grant was not revoked.
- Credential Manager failure: run in the same Windows user session and do not paste secrets into command arguments.

## QQ Mail setup

1. Enable IMAP and SMTP in QQ Mail settings.
2. Generate a QQ Mail authorization code. Do not use the normal QQ password.
3. Run node dist/enroll.js qq in an interactive Windows terminal.
4. Enter the address, account name, and hidden authorization code.

Repair an existing credential-backed QQ account:

    node dist/enroll.js qq-repair

With multiple QQ accounts, select one by account ID, exact name, or email:

    node dist/enroll.js qq-repair ACCOUNT_ID_OR_NAME

Reauthorize Gmail through the browser without recreating account metadata:

    node dist/enroll.js gmail-repair ACCOUNT_ID_OR_NAME

Repair uses the account's exact Credential Manager targets, performs authentication-only verification, and restores the previous credential if verification fails. It does not read mail or test SMTP. Never pipe or pass a QQ authorization code, OAuth code, refresh token, or client secret on the command line.

## Generic IMAP/SMTP setup (legacy)

Providers other than Gmail and QQ Mail use the inherited generic account path. From a built clone, start the local setup UI without changing an MCP client configuration:

    node dist/setup.js --skip-claude --no-open

Open the localhost URL printed by the command, enter the provider's IMAP/SMTP hosts, ports, TLS settings, username, and provider-issued password or app password, then stop the setup process. The UI binds only to 127.0.0.1: do not expose it through LAN binding, port forwarding, tunnels, or a reverse proxy. It is a local setup aid, not a remote administration panel. The `imap_add_account` and `imap_update_account` tools can also configure this path, but doing so sends credentials through the MCP client/model; the local setup UI or startup environment overrides are safer.

This compatibility path does not use Windows Credential Manager. Its password may be AES-encrypted in `~/.imap-mcp/accounts.json` with a key stored under the same directory, so an attacker who can read both files can recover it. Gmail and QQ Mail users should use `dist/enroll.js` instead.

## Proxy setup

Gmail authorization opens in the browser; the token endpoint request is made by Node. Configure standard variables before starting enrollment or the MCP server:

    $env:HTTPS_PROXY = "http://proxy-host:proxy-port"
    $env:HTTP_PROXY = "http://proxy-host:proxy-port"
    $env:NO_PROXY = "127.0.0.1,localhost"
    $env:IMAP_MCP_MAIL_PROXY = "http://proxy-host:proxy-port"

`HTTP_PROXY` and `HTTPS_PROXY` are inherited by Gmail OAuth/token requests and, unless `IMAP_MCP_MAIL_PROXY` is set, by IMAP/SMTP transports launched from the same CLI or MCP process. `IMAP_MCP_MAIL_PROXY` remains the explicit mail-transport override. `NO_PROXY` applies to provider hosts and should include the loopback OAuth callback. Do not commit credential-bearing proxy URLs; TLS validation remains enabled.

## Configuration reference

Existing process environment values take precedence over values loaded from `.env`. Provider-bound Gmail/QQ authentication uses Windows Credential Manager; generic password overrides below apply only to legacy accounts. A non-empty `IMAP_MCP_ENABLED_TOOLS` allowlist takes precedence over `IMAP_MCP_READ_ONLY`.

| Variable | Purpose |
| --- | --- |
| `IMAP_MCP_ENABLED_TOOLS` | Comma-separated MCP tool allowlist; names may omit the `imap_` prefix. |
| `IMAP_MCP_READ_ONLY` | Truthy values (`1`, `true`, `yes`, `on`) expose the 21-tool mailbox-read-only subset, including five Gmail API read tools. |
| `IMAP_DOWNLOAD_DIR` | Root for uploaded and downloaded attachment files. |
| `IMAP_MCP_CONFIG_DIR` | Optional account-metadata directory override for isolated profiles and clean-room testing; defaults to `~/.imap-mcp`. |
| `IMAP_MAX_UPLOAD_SIZE` | Maximum decoded attachment upload size in bytes; default 25 MiB. |
| `IMAP_UPLOAD_TTL_MS` | Lifetime of uploaded temporary attachment files; default 24 hours. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Gmail OAuth/token/API HTTP proxy settings; lowercase variants are also accepted. |
| `IMAP_MCP_MAIL_PROXY` | Optional explicit HTTP CONNECT, HTTPS, or SOCKS proxy override shared by IMAP and SMTP transports. |
| `IMAP_SEARCH_FOLDER_TIMEOUT_MS` | Per-folder cross-folder-search deadline; defaults to 10000 ms. |
| `IMAP_SEARCH_ALL_TIMEOUT_MS` | Overall cross-folder-search deadline, including folder discovery; defaults to 30000 ms. |
| `IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME` / `_IMAP_PASSWORD` | Startup-only generic IMAP credential overrides. `<NAME>` is the account name uppercased with non-alphanumeric characters replaced by `_`. |
| `IMAP_MCP_ACCOUNT_<NAME>_SMTP_USERNAME` / `_SMTP_PASSWORD` | Startup-only generic SMTP credential overrides using the same normalized name. |
| `IMAP_SPAM_DOMAINS`, `IMAP_WHITELIST_DOMAINS` | Comma-separated local spam and allowlist domain additions. |
| `PORT` | Port for the legacy local setup UI only; default 3000. |

`IPQUALITYSCORE_API_KEY` is referenced by a legacy internal reputation helper, but no currently registered MCP tool calls that helper. Setting it does not enable an advertised capability.

## Security model

- Gmail refresh tokens, Gmail client secrets, and QQ authorization codes use Windows Credential Manager on the hardened provider path.
- New entries use the MailAgentMCP namespace. Exact legacy CodexLab targets remain readable for compatibility; arbitrary target references are rejected.
- Removing a provider-bound account deletes its bound Credential Manager entries transactionally; a persistence failure restores both account metadata and credentials when possible.
- accounts.json contains provider/account metadata and credential target references, not those provider secrets.
- The connected MCP client and model can receive email bodies returned by read tools. Review that client's data policy.
- Sending is preview-confirmed. Within one running server process, each frozen draft permits at most one send attempt; an ambiguous SMTP outcome is not retried automatically. Draft IDs and state are in memory and do not survive a restart. Delete, move, flag, folder, account, spam-mutation, and draft tools still modify state.
- Set IMAP_MCP_READ_ONLY=true for a 21-tool mailbox-read-only surface, or IMAP_MCP_ENABLED_TOOLS for an explicit allowlist. This mode is not filesystem-read-only: attachment download tools may save files inside the attachment root.
- Attachment paths are confined to IMAP_DOWNLOAD_DIR or, by default, the current user's Downloads/imap-attachments directory.
- The legacy generic-provider account path may store an AES-encrypted password in ~/.imap-mcp/accounts.json with a colocated local key. This protects against casual plaintext disclosure, not an attacker who can read both files. Use hardened provider enrollment for Gmail and QQ Mail.
- The server does not intentionally write mail bodies to persistent storage, but pending safe-send content remains in process memory and your MCP client may retain tool results.
- No claim of complete security is made. A malicious process running as the same OS user can access many of the same local resources.

See SECURITY.md for threat boundaries and responsible disclosure.

## Architecture

    MCP client
        |
        | stdio JSON-RPC
        v
    MCP tool registry
        |-- AccountManager + credential resolver
        |-- GmailApiService (HTTPS read-only)
        |-- ImapService / SmtpService
        |-- SafeSendService
        |-- attachment-root boundary
        v
    Gmail API or Gmail/QQ Mail IMAP/SMTP

Configuration metadata lives under ~/.imap-mcp. Provider secrets are resolved into memory only when needed.

## Troubleshooting

- node or npm fails: confirm node --version is at least 22.12 and use npm ci.
- mail-agent-enroll prompts instead of showing help: rebuild with npm run build.
- Gmail token endpoint cannot connect: set HTTP_PROXY/HTTPS_PROXY before launching, keep 127.0.0.1 in NO_PROXY, and verify the proxy accepts HTTPS CONNECT.
- Gmail or QQ IMAP/SMTP cannot connect while OAuth works: set `IMAP_MCP_MAIL_PROXY` to a trusted HTTP CONNECT or SOCKS proxy.
- Gmail IMAP fails while Gmail API works: use Gmail API tools to read messages and download bounded attachments. Gmail API reply/forward previews can freeze a draft, but sending still requires SMTP and a separate `imap_confirm_send` confirmation. Gmail SMTP normally places its own Sent copy; the server skips a second IMAP append unless `saveToSent` is explicitly true. API read success is not delivery proof.
- QQ authentication fails: generate a new authorization code and run qq-repair, adding an account selector when more than one QQ account exists.
- Gmail authorization or refresh fails: run gmail-repair for the affected account; the command obtains a fresh refresh token through browser OAuth.
- Credential target mismatch: do not edit accounts.json or reuse another account's target. Re-enroll locally.
- Attachment path rejected: use a path inside IMAP_DOWNLOAD_DIR.
- MCP client sees no tools: run npm run build, use the absolute dist/index.js path, and inspect IMAP_MCP_READ_ONLY or IMAP_MCP_ENABLED_TOOLS.

## FAQ

### Does this upload my mailbox to a hosted service?

No hosted mail service is part of this repository. The local MCP process connects to the configured provider. Tool results are still sent to your chosen MCP client/model.

### Can I use Gmail app passwords?

Not on the hardened Gmail path. It requires OAuth 2.0 and intentionally disables password fallback.

### Can an agent send without confirmation?

No through registered production tools. It must preview, receive a draft ID, and call imap_confirm_send with confirmed: true.

### Does it support macOS or Linux?

The MCP server and generic IMAP features may run there, but hardened Gmail/QQ enrollment currently requires Windows Credential Manager.

### Is the npm package available?

No. Version 0.1.1 is installed from [GitHub](https://github.com/SinoEdwards/mail-agent-mcp); npm and MCP Registry publishing remain separate future release decisions.

## Roadmap

- Cross-platform secure credential backends.
- Migrate the legacy generic IMAP/SMTP password store to system credential backends.
- Signed releases and provider smoke workflows that never expose real credentials to public CI.
- Additional provider adapters only when they add real security or usability value.

## Contributing

Read AGENTS.md and CONTRIBUTING.md when present. Keep tool schemas, descriptions, docs, and tests synchronized. Use mocks and localhost fixtures; never put real mailbox credentials in tests or issues.

## License

MIT. See LICENSE.
