# Contributing

Mail Agent MCP welcomes focused fixes that improve provider compatibility, MCP contracts, documentation, or safety.

## Before opening a change

- Search existing issues and keep one concern per pull request.
- Never include real mailbox data, email addresses, OAuth codes, client IDs, client secrets, tokens, authorization codes, proxy credentials, account JSON, or Credential Manager exports.
- Use synthetic addresses under example.com/example.test and obviously fake secrets.
- Treat email bodies, headers, filenames, and attachment bytes as untrusted input.

## Local development

Requirements: Node.js 22.12 or newer and npm.

    npm ci
    npm test
    npm run build
    npm run lint
    npm run check:secrets
    npm pack --dry-run

Provider integration tests are not part of public CI. Do not add real credentials to GitHub Actions. If a change needs manual Gmail or QQ validation, describe the redacted procedure and outcome without subjects, recipients, message IDs, or credential values.

## Design expectations

- Gmail and QQ secrets belong in Windows Credential Manager, never accounts.json or tool arguments.
- New credential targets use the MailAgentMCP namespace; legacy CodexLab targets are compatibility-only.
- Sending must remain preview-confirmed. Direct-send tools must not become publicly registerable.
- Mailbox mutations need explicit tool semantics and tests.
- Attachment paths must remain inside the configured attachment root.
- Errors and logs must not reflect provider response bodies or credential target values.

## Pull requests

Include:

1. the user-visible problem;
2. the smallest implemented solution;
3. tests added or changed;
4. exact validation commands and results;
5. security or compatibility tradeoffs.

Do not commit generated dist, coverage, local configuration, logs, or package tarballs. Maintainers may ask for a smaller change if a patch combines unrelated refactors.

## Vulnerabilities

Do not open a public issue for a suspected credential leak or exploitable security flaw. Follow SECURITY.md.
