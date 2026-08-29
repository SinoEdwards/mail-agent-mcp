import { describe, expect, it } from 'vitest';
import { buildImapAuth, buildSmtpAuth } from '../src/credentials/account-auth.js';

const SYNTHETIC_PASSWORD_1 = ["authoriza", "tion-code"].join('');
const SYNTHETIC_ACCESS_TOKEN_2 = ["access", "-token"].join('');

describe('shared protocol auth builders', () => {
  it('builds QQ password auth for both protocols', () => {
    const auth = { kind: 'password' as const, user: 'person@example.test', password: SYNTHETIC_PASSWORD_1 };
    expect(buildImapAuth(auth)).toEqual({ user: 'person@example.test', pass: 'authorization-code' });
    expect(buildSmtpAuth(auth)).toEqual({ user: 'person@example.test', pass: 'authorization-code' });
  });

  it('builds Gmail OAuth using accessToken only and never pass', () => {
    const auth = { kind: 'oauth2' as const, user: 'person@example.test', accessToken: SYNTHETIC_ACCESS_TOKEN_2 };
    const imap = buildImapAuth(auth);
    const smtp = buildSmtpAuth(auth);
    expect(imap).toEqual({ user: 'person@example.test', accessToken: SYNTHETIC_ACCESS_TOKEN_2 });
    expect(smtp).toEqual({ type: 'OAuth2', user: 'person@example.test', accessToken: SYNTHETIC_ACCESS_TOKEN_2 });
    expect(imap).not.toHaveProperty('pass');
    expect(smtp).not.toHaveProperty('pass');
  });
});
