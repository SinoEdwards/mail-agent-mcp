import { describe, expect, it } from 'vitest';
import { buildImapAuth, buildSmtpAuth } from '../src/credentials/account-auth.js';

describe('shared protocol auth builders', () => {
  it('builds QQ password auth for both protocols', () => {
    const auth = { kind: 'password' as const, user: 'person@qq.com', password: 'authorization-code' };
    expect(buildImapAuth(auth)).toEqual({ user: 'person@qq.com', pass: 'authorization-code' });
    expect(buildSmtpAuth(auth)).toEqual({ user: 'person@qq.com', pass: 'authorization-code' });
  });

  it('builds Gmail OAuth using accessToken only and never pass', () => {
    const auth = { kind: 'oauth2' as const, user: 'person@gmail.com', accessToken: 'access-token' };
    const imap = buildImapAuth(auth);
    const smtp = buildSmtpAuth(auth);
    expect(imap).toEqual({ user: 'person@gmail.com', accessToken: 'access-token' });
    expect(smtp).toEqual({ type: 'OAuth2', user: 'person@gmail.com', accessToken: 'access-token' });
    expect(imap).not.toHaveProperty('pass');
    expect(smtp).not.toHaveProperty('pass');
  });
});
