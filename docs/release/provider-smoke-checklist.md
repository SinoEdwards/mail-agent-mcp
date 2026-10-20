# Clean-room provider smoke checklist

Run this manually from a fresh Windows user profile or isolated HOME. Existing Credential Manager entries and author configuration do not count as evidence.

## Evidence rules

- Record only PASS/FAIL, provider, command version, and sanitized error category.
- Never record addresses, subjects, bodies, UIDs, attachment names, OAuth codes, tokens, client secrets, authorization codes, or proxy credentials.
- Do not send mail, delete/move mail, change flags, download attachments, or open message bodies.
- Stop immediately if a command would expose a credential in argv, environment output, logs, or JSON.

## Preparation

- [ ] Fresh clone with no accounts.json, .key, .env, or MailAgentMCP/CodexLab Credential Manager entries.
- [ ] Node 22.12+ and npm ci, npm run build, npm run lint all PASS.
- [ ] Optional proxy configured with HTTP_PROXY/HTTPS_PROXY and loopback in NO_PROXY; values are not recorded.
- [ ] MCP starts with IMAP_MCP_READ_ONLY=true and exposes the documented read-only tool set.

## Gmail

- [ ] Create or select a Google Desktop OAuth client; if the consent screen is in testing, add the test user.
- [ ] Run node dist/enroll.js gmail in an interactive terminal.
- [ ] Browser callback binds only to 127.0.0.1 and token exchange succeeds.
- [ ] accounts.json contains only metadata and MailAgentMCP target references.
- [ ] Windows Credential Manager contains separate refresh-token and client-secret entries.
- [ ] Restart the process and authenticate through refresh-token exchange.
- [ ] Verify the Gmail API is enabled in the OAuth project and `gmail_api_list_labels`, `gmail_api_search_messages`, metadata-only `gmail_api_get_message`, and `gmail_api_list_attachments` succeed in a read-only MCP session; record counts and status only. Do not download a real attachment during this metadata smoke check.
- [ ] Confirm Gmail API string message IDs are used only by Gmail API tools, never passed to an IMAP UID tool.
- [ ] Authenticate to SMTP without submitting a message; record only PASS/FAIL.
- [ ] list folders succeeds.
- [ ] search metadata with limit 1 succeeds without reading a body or changing Seen.
- [ ] disconnect succeeds.
- [ ] Run node dist/enroll.js gmail-repair ACCOUNT_ID_OR_NAME; verify success and unchanged account metadata.
- [ ] Simulate a rejected replacement using mocks only; rollback tests remain PASS.

## QQ Mail

- [ ] Enable IMAP/SMTP and generate a fresh provider authorization code.
- [ ] Run node dist/enroll.js qq in an interactive terminal.
- [ ] accounts.json contains only metadata and a MailAgentMCP target reference.
- [ ] Windows Credential Manager contains the authorization-code entry.
- [ ] Restart and authenticate to IMAP.
- [ ] Authenticate to SMTP without submitting a message; record only PASS/FAIL.
- [ ] list folders succeeds.
- [ ] search metadata with limit 1 succeeds without reading a body or changing Seen.
- [ ] disconnect succeeds.
- [ ] With two synthetic/configured QQ accounts, run qq-repair ACCOUNT_ID_OR_NAME and confirm only the selected target changes.
- [ ] Simulate rejected replacement and rollback using mocks only.

## Account removal

- [ ] Remove a disposable provider account.
- [ ] Account metadata is removed.
- [ ] Its exact bound Credential Manager entries are removed.
- [ ] Other account targets remain unchanged.

## Result

Record Gmail and QQ separately as PASS, FAIL, or NOT RUN. A NOT RUN result must never be described as provider compatibility proof.
An SMTP authentication check does not prove final message delivery. A delivery test needs separate maintainer authorization and a controlled recipient.
