import { describe, expect, it, vi } from 'vitest';
import type { AccountManager } from '../src/services/account-manager.js';
import type { CredentialBackend, SecretHandle } from '../src/credentials/credential-backend.js';
import type { ImapAccount } from '../src/types/index.js';
import { AccountEnrollmentService } from '../src/credentials/account-enrollment.js';

const SYNTHETIC_AUTHORIZATION_CODE_1 = [" qq-s", "ecret "].join('');
const SYNTHETIC_CLIENT_SECRET_2 = [" client", "-secret "].join('');
const SYNTHETIC_REFRESH_TOKEN_3 = [" refresh", "-secret "].join('');
const SYNTHETIC_REFRESH_TOKEN_4 = ["refres", "h-token"].join('');
const SYNTHETIC_AUTHORIZATION_CODE_5 = ["new-s", "ecret"].join('');
const SYNTHETIC_CLIENT_SECRET_6 = ["client", "-secret"].join('');
const SYNTHETIC_REFRESH_TOKEN_7 = ["new-s", "ecret"].join('');
const SYNTHETIC_AUTHORIZATION_CODE_8 = ["qq-s", "ecret"].join('');
const SYNTHETIC_REFRESH_TOKEN_9 = ["gmail-", "secret"].join('');
const SYNTHETIC_CLIENT_SECRET_10 = ["new-c", "lient"].join('');
const SYNTHETIC_REFRESH_TOKEN_11 = ["new-r", "efresh"].join('');
const SYNTHETIC_AUTHORIZATION_CODE_12 = ["top-secr", "et-value"].join('');

class FakeHandle implements SecretHandle {
  disposed = false;
  constructor(private readonly value: string) {}
  read(): unknown { return this.value; }
  dispose(): void { this.disposed = true; }
}

class FakeCredentialBackend implements CredentialBackend {
  readonly values = new Map<string, string>();
  readonly handles: FakeHandle[] = [];
  writeError?: Error;
  deleteError?: Error;
  failWriteAt?: number;
  writeCalls = 0;

  read(target: string): SecretHandle | undefined {
    const value = this.values.get(target);
    if (value === undefined) return undefined;
    const handle = new FakeHandle(value);
    this.handles.push(handle);
    return handle;
  }

  write(target: string, secret: string): void {
    this.writeCalls += 1;
    if (this.writeCalls === this.failWriteAt) throw new Error('write failed');
    if (this.writeError) throw this.writeError;
    this.values.set(target, secret);
  }

  delete(target: string): boolean {
    if (this.deleteError) throw this.deleteError;
    return this.values.delete(target);
  }
}

const accountManager = (
  implementation?: (account: Omit<ImapAccount, 'id'>) => Promise<ImapAccount>,
) => {
  const addAccount = vi.fn(
    implementation
      ?? (async (account: Omit<ImapAccount, 'id'>) => ({ ...account, id: 'account-id' })),
  );
  return { addAccount } as Pick<AccountManager, 'addAccount'> & { addAccount: typeof addAccount };
};

describe('AccountEnrollmentService', () => {
  it('persists a QQ account schema without putting the authorization code in JSON', async () => {
    const backend = new FakeCredentialBackend();
    const manager = accountManager();
    const service = new AccountEnrollmentService(backend, manager);

    const result = await service.enrollQq({
      email: ' USER@QQ.COM ',
      name: ' QQ ',
      authorizationCode: SYNTHETIC_AUTHORIZATION_CODE_1,
    });

    const target = 'MailAgentMCP:qq:user@qq.com:authorization_code';
    expect(backend.values.get(target)).toBe('qq-secret');
    expect(manager.addAccount).toHaveBeenCalledWith({
      name: 'QQ',
      email: 'user@qq.com',
      host: 'imap.qq.com',
      port: 993,
      user: 'user@qq.com',
      password: '',
      tls: true,
      smtp: {
        host: 'smtp.qq.com',
        port: 465,
        secure: true,
        user: 'user@qq.com',
        password: '',
      },
      auth: { kind: 'credential', provider: 'qq', credentialTarget: target },
    });
    expect(JSON.stringify(result)).not.toContain('qq-secret');
  });

  it('persists Gmail metadata without putting the refresh token in JSON', async () => {
    const backend = new FakeCredentialBackend();
    const manager = accountManager();
    const service = new AccountEnrollmentService(backend, manager);
    const result = await service.enrollGmail({
      email: ' USER@GMAIL.COM ',
      name: ' Gmail ',
      clientId: ' client-id ',
      clientSecret: SYNTHETIC_CLIENT_SECRET_2,
      refreshToken: SYNTHETIC_REFRESH_TOKEN_3,
    });

    const target = 'MailAgentMCP:gmail:user@gmail.com:refresh_token';
    const clientSecretTarget = 'MailAgentMCP:gmail:user@gmail.com:client_secret';
    expect(backend.values.get(target)).toBe('refresh-secret');
    expect(backend.values.get(clientSecretTarget)).toBe('client-secret');
    expect(manager.addAccount).toHaveBeenCalledWith(expect.objectContaining({
      email: 'user@gmail.com',
      host: 'imap.gmail.com',
      password: '',
      auth: {
        kind: 'oauth2',
        provider: 'gmail',
        credentialTarget: target,
        clientId: 'client-id',
        clientSecretTarget,
      },
    }));
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
    expect(JSON.stringify(result)).not.toContain('client-secret');
  });

  it.each([
    { email: ' ', name: 'QQ', authorizationCode: 'secret' },
    { email: 'user@qq.com', name: '', authorizationCode: 'secret' },
    { email: 'user@qq.com', name: 'QQ', authorizationCode: ' ' },
  ])('rejects empty QQ input before mutation', async (input) => {
    const backend = new FakeCredentialBackend();
    const manager = accountManager();
    const service = new AccountEnrollmentService(backend, manager);
    await expect(service.enrollQq(input)).rejects.toThrow('is required');
    expect(backend.values.size).toBe(0);
    expect(manager.addAccount).not.toHaveBeenCalled();
  });

  it('rejects a missing Gmail client secret before any mutation', async () => {
    const backend = new FakeCredentialBackend();
    const manager = accountManager();
    const service = new AccountEnrollmentService(backend, manager);
    await expect(service.enrollGmail({
      email: 'user@gmail.com',
      name: 'Gmail',
      clientId: 'client-id',
      clientSecret: ' ',
      refreshToken: SYNTHETIC_REFRESH_TOKEN_4,
    })).rejects.toThrow(/client secret.*required/i);
    expect(backend.values.size).toBe(0);
    expect(manager.addAccount).not.toHaveBeenCalled();
  });

  it('rejects an invalid target account before mutation', async () => {
    const backend = new FakeCredentialBackend();
    const manager = accountManager();
    const service = new AccountEnrollmentService(backend, manager);
    await expect(service.enrollQq({
      email: 'bad:account',
      name: 'QQ',
      authorizationCode: 'secret',
    })).rejects.toThrow(/invalid account/i);
    expect(backend.values.size).toBe(0);
    expect(manager.addAccount).not.toHaveBeenCalled();
  });

  it('does not add an account when credential write fails', async () => {
    const backend = new FakeCredentialBackend();
    backend.writeError = new Error('write failed');
    const manager = accountManager();
    const service = new AccountEnrollmentService(backend, manager);
    await expect(service.enrollQq({
      email: 'user@qq.com',
      name: 'QQ',
      authorizationCode: 'secret',
    })).rejects.toThrow('write failed');
    expect(manager.addAccount).not.toHaveBeenCalled();
  });

  it('deletes a newly written credential when account persistence fails', async () => {
    const backend = new FakeCredentialBackend();
    const manager = accountManager(async () => { throw new Error('account failed'); });
    const service = new AccountEnrollmentService(backend, manager);
    await expect(service.enrollQq({
      email: 'user@qq.com',
      name: 'QQ',
      authorizationCode: SYNTHETIC_AUTHORIZATION_CODE_5,
    })).rejects.toThrow('account failed');
    expect(backend.values.size).toBe(0);
  });

  it('restores an existing credential and disposes its handle', async () => {
    const backend = new FakeCredentialBackend();
    const target = 'MailAgentMCP:gmail:user@gmail.com:refresh_token';
    backend.values.set(target, 'old-secret');
    const manager = accountManager(async () => { throw new Error('account failed'); });
    const service = new AccountEnrollmentService(backend, manager);
    await expect(service.enrollGmail({
      email: 'user@gmail.com',
      name: 'Gmail',
      clientId: 'client-id',
      clientSecret: SYNTHETIC_CLIENT_SECRET_6,
      refreshToken: SYNTHETIC_REFRESH_TOKEN_7,
    })).rejects.toThrow('account failed');
    expect(backend.values.get(target)).toBe('old-secret');
    expect(backend.handles[0]?.disposed).toBe(true);
  });

  it('keeps QQ and Gmail targets isolated', async () => {
    const backend = new FakeCredentialBackend();
    const service = new AccountEnrollmentService(backend, accountManager());
    await service.enrollQq({
      email: 'same@example.com',
      name: 'QQ',
      authorizationCode: SYNTHETIC_AUTHORIZATION_CODE_8,
    });
    await service.enrollGmail({
      email: 'same@example.com',
      name: 'Gmail',
      clientId: 'client-id',
      clientSecret: SYNTHETIC_CLIENT_SECRET_6,
      refreshToken: SYNTHETIC_REFRESH_TOKEN_9,
    });
    expect(backend.values.size).toBe(3);
  });

  it('rolls back the first Gmail credential when the second write fails', async () => {
    const backend = new FakeCredentialBackend();
    backend.failWriteAt = 2;
    const manager = accountManager();
    const service = new AccountEnrollmentService(backend, manager);

    await expect(service.enrollGmail({
      email: 'user@gmail.com',
      name: 'Gmail',
      clientId: 'client-id',
      clientSecret: SYNTHETIC_CLIENT_SECRET_6,
      refreshToken: SYNTHETIC_REFRESH_TOKEN_4,
    })).rejects.toThrow('write failed');

    expect(backend.values.size).toBe(0);
    expect(manager.addAccount).not.toHaveBeenCalled();
  });

  it('restores both prior Gmail credentials when account persistence fails', async () => {
    const backend = new FakeCredentialBackend();
    const refreshTarget = 'MailAgentMCP:gmail:user@gmail.com:refresh_token';
    const clientTarget = 'MailAgentMCP:gmail:user@gmail.com:client_secret';
    backend.values.set(refreshTarget, 'old-refresh');
    backend.values.set(clientTarget, 'old-client');
    const manager = accountManager(async () => { throw new Error('account failed'); });
    const service = new AccountEnrollmentService(backend, manager);

    await expect(service.enrollGmail({
      email: 'user@gmail.com',
      name: 'Gmail',
      clientId: 'client-id',
      clientSecret: SYNTHETIC_CLIENT_SECRET_10,
      refreshToken: SYNTHETIC_REFRESH_TOKEN_11,
    })).rejects.toThrow('account failed');

    expect(backend.values.get(refreshTarget)).toBe('old-refresh');
    expect(backend.values.get(clientTarget)).toBe('old-client');
    expect(backend.handles.every((handle) => handle.disposed)).toBe(true);
  });

  it('uses a generic secret-free error if rollback fails', async () => {
    const backend = new FakeCredentialBackend();
    backend.deleteError = new Error('delete failed with top-secret-value');
    const accountFailure = new Error('account failed');
    const manager = accountManager(async () => { throw accountFailure; });
    const service = new AccountEnrollmentService(backend, manager);
    let error: unknown;
    try {
      await service.enrollQq({
        email: 'user@qq.com',
        name: 'QQ',
        authorizationCode: SYNTHETIC_AUTHORIZATION_CODE_12,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Account enrollment failed and credential rollback failed',
    );
    expect((error as Error).message).not.toContain('top-secret-value');
    expect((error as Error).cause).toBe(accountFailure);
  });
});
