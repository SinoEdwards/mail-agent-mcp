# Sent-copy preparation warning

## Scope

After SMTP accepts a message, the safe-send result must accurately report whether a requested IMAP Sent-folder copy could be prepared. The confirmed QQ-to-Gmail attachment test did have a fresh QQ Sent record; this design addresses a separate latent failure path.

## Options considered

1. **Warn after SMTP success (selected).** Preserve the final `sent` state, add the existing `sent_copy_failed` warning when raw RFC 822 composition yielded no message and an IMAP Sent copy was requested, and block automatic resend. This changes only result reporting.
2. Reject sending before SMTP if Sent-copy preparation fails. This would make a secondary bookkeeping step block an otherwise deliverable message and change established send behavior.
3. Capture the exact SMTP wire message for IMAP append. This adds transport complexity without being necessary to report the failure accurately.

The maintainer approved option 1 on 2026-10-20.

## Behavior

- The existing preview and explicit confirmation gate remains mandatory.
- SMTP is attempted once. A successful SMTP result remains `sent` even if the Sent copy cannot be prepared.
- If `saveToSent=false`, no IMAP append is expected and no warning is added.
- Gmail continues to rely on its server-side Sent behavior by default. Explicit `saveToSent=true` requests an IMAP append and is eligible for the warning.
- For an account that requests an IMAP Sent append, missing raw message data produces the existing generic `sent_copy_failed` warning. No internal exception detail, message content, or credentials appear in the response.
- An already-confirmed draft remains non-retryable; a repeat confirmation returns `already_sent`.

## Verification

Use synthetic accounts and mocked SMTP/IMAP services. A regression test first demonstrates that missing raw data incorrectly returned plain `sent`; after the fix it must return `sent` with `sent_copy_failed`, without attempting an append or a second SMTP send. Separate tests preserve Gmail's default and `saveToSent=false` behavior. Run the full build, test, lint, coverage, secret scan, dependency audit, package dry run, and whitespace check before pushing.
