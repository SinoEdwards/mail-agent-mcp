# Local usage examples

Build from the current clone:

    npm ci
    npm run build
    node dist/enroll.js --help

Enroll on Windows from an interactive terminal:

    node dist/enroll.js gmail
    node dist/enroll.js qq

Register the local build with Codex:

    codex mcp add mail-agent -- node "$PWD\dist\index.js"

Start with read-only access when possible:

    codex mcp add --env IMAP_MCP_READ_ONLY=true mail-agent-readonly -- node "$PWD\dist\index.js"

Example agent requests:

- List configured accounts.
- Search INBOX for messages with a given subject without changing flags.
- Read one selected message.
- Preview an email, show me the preview, and wait for my explicit confirmation.

Never paste a password, QQ authorization code, OAuth code, client secret, or token into an agent prompt. Use the local enrollment CLI.
