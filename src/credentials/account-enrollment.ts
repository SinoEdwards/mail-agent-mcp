import type { AccountManager } from '../services/account-manager.js';
import type { ImapAccount } from '../types/index.js';
import type { CredentialBackend } from './credential-backend.js';
import { credentialTarget, gmailClientSecretTarget } from './credential-backend.js';

export interface QqEnrollmentInput {
  email: string;
  name: string;
  authorizationCode: string;
}

export interface GmailEnrollmentInput {
  email: string;
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

type EnrollmentAccountManager = Pick<AccountManager, 'addAccount'>;

interface CredentialSnapshot {
  exists: boolean;
  value?: string;
}

export class AccountEnrollmentService {
  constructor(
    private readonly credentials: CredentialBackend,
    private readonly accounts: EnrollmentAccountManager,
  ) {}

  async enrollQq(input: QqEnrollmentInput): Promise<ImapAccount> {
    const email = required(input.email, 'QQ email').toLowerCase();
    const name = required(input.name, 'Account name');
    const authorizationCode = required(input.authorizationCode, 'QQ authorization code');
    const target = credentialTarget('qq', email);

    return this.persist([{ target, secret: authorizationCode }], {
      name,
      email,
      host: 'imap.qq.com',
      port: 993,
      user: email,
      password: '',
      tls: true,
      smtp: {
        host: 'smtp.qq.com',
        port: 465,
        secure: true,
        user: email,
        password: '',
      },
      auth: {
        kind: 'credential',
        provider: 'qq',
        credentialTarget: target,
      },
    });
  }

  async enrollGmail(input: GmailEnrollmentInput): Promise<ImapAccount> {
    const email = required(input.email, 'Gmail email').toLowerCase();
    const name = required(input.name, 'Account name');
    const clientId = required(input.clientId, 'Gmail OAuth clientId');
    const clientSecret = required(input.clientSecret, 'Gmail OAuth client secret');
    const refreshToken = required(input.refreshToken, 'Gmail refresh token');
    const target = credentialTarget('gmail', email);
    const clientSecretTarget = gmailClientSecretTarget(email);

    return this.persist([
      { target, secret: refreshToken },
      { target: clientSecretTarget, secret: clientSecret },
    ], {
      name,
      email,
      host: 'imap.gmail.com',
      port: 993,
      user: email,
      password: '',
      tls: true,
      smtp: {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        user: email,
        password: '',
      },
      auth: {
        kind: 'oauth2',
        provider: 'gmail',
        credentialTarget: target,
        clientId,
        clientSecretTarget,
      },
    });
  }

  private async persist(
    credentials: Array<{ target: string; secret: string }>,
    account: Omit<ImapAccount, 'id'>,
  ): Promise<ImapAccount> {
    const snapshots = credentials.map(({ target, secret }) => ({
      ...this.snapshot(target),
      target,
      secret,
    }));
    const written: Array<CredentialSnapshot & { target: string; secret: string }> = [];

    try {
      for (const snapshot of snapshots) {
        this.credentials.write(snapshot.target, snapshot.secret);
        written.push(snapshot);
      }
      return await this.accounts.addAccount(account);
    } catch (cause) {
      let rollbackFailed = false;
      for (const snapshot of written.reverse()) {
        try {
          if (snapshot.exists) {
            this.credentials.write(snapshot.target, snapshot.value!);
          } else if (!this.credentials.delete(snapshot.target)) {
            throw new Error('Credential deletion failed');
          }
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw new Error('Account enrollment failed and credential rollback failed', {
          cause,
        });
      }
      throw cause;
    }
  }

  private snapshot(target: string): CredentialSnapshot {
    const handle = this.credentials.read(target);
    if (!handle) return { exists: false };

    try {
      const value = handle.read();
      if (typeof value !== 'string') {
        throw new Error('Stored credential has an invalid value');
      }
      return { exists: true, value };
    } finally {
      handle.dispose();
    }
  }
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}
