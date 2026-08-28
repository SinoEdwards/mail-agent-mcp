import { describe, expect, it, vi } from 'vitest';
import type { CredentialBackend, SecretHandle } from '../src/credentials/credential-backend.js';
import { CredentialRollbackError, rotateCredential } from '../src/credentials/credential-rotation.js';

class FakeHandle implements SecretHandle {
  disposed = false;
  constructor(private readonly value: unknown) {}
  read(): unknown { return this.value; }
  dispose(): void { this.disposed = true; }
}

class FakeBackend implements CredentialBackend {
  readonly values = new Map<string, string>();
  readonly handles: FakeHandle[] = [];
  readonly reads: string[] = [];
  readonly writes: Array<{ target: string; secret: string }> = [];
  readonly deletes: string[] = [];
  writeError?: Error;
  deleteError?: Error;

  read(target: string): SecretHandle | undefined {
    this.reads.push(target);
    const value = this.values.get(target);
    if (value === undefined) return undefined;
    const handle = new FakeHandle(value);
    this.handles.push(handle);
    return handle;
  }
  write(target: string, secret: string): void {
    this.writes.push({ target, secret });
    if (this.writeError) throw this.writeError;
    this.values.set(target, secret);
  }
  delete(target: string): boolean {
    this.deletes.push(target);
    if (this.deleteError) throw this.deleteError;
    return this.values.delete(target);
  }
}

const target = 'CodexLab:QQMail:user@qq.com:authorization_code';
const options = (credentials: CredentialBackend, replacement: string, verify: () => Promise<void>) => ({
  credentials,
  target,
  expectedTarget: target,
  replacement,
  verify,
});

describe('rotateCredential', () => {
  it('keeps the replacement after successful verification', async () => {
    const backend = new FakeBackend();
    backend.values.set(target, 'old-code');
    const verify = vi.fn(async () => undefined);
    await rotateCredential(options(backend, 'new-code', verify));
    expect(backend.values.get(target)).toBe('new-code');
    expect(verify).toHaveBeenCalledOnce();
    expect(backend.handles[0]?.disposed).toBe(true);
  });

  it('restores the exact old secret when verification fails', async () => {
    const backend = new FakeBackend();
    backend.values.set(target, 'old-code');
    const failure = new Error('verification failed');
    await expect(rotateCredential(options(backend, 'new-code', async () => { throw failure; }))).rejects.toBe(failure);
    expect(backend.values.get(target)).toBe('old-code');
    expect(backend.writes).toEqual([{ target, secret: 'new-code' }, { target, secret: 'old-code' }]);
    expect(backend.handles[0]?.disposed).toBe(true);
  });

  it('deletes a newly created credential when verification fails', async () => {
    const backend = new FakeBackend();
    const failure = new Error('verification failed');
    await expect(rotateCredential(options(backend, 'new-code', async () => { throw failure; }))).rejects.toBe(failure);
    expect(backend.values.has(target)).toBe(false);
    expect(backend.deletes).toEqual([target]);
  });

  it('rejects target mismatch before credential I/O', async () => {
    const backend = new FakeBackend();
    const verify = vi.fn(async () => undefined);
    await expect(rotateCredential({ ...options(backend, 'new-code', verify), target: 'wrong-target' })).rejects.toThrow(/target mismatch/i);
    expect(backend.reads).toEqual([]);
    expect(backend.writes).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects an empty replacement before credential I/O', async () => {
    const backend = new FakeBackend();
    const verify = vi.fn(async () => undefined);
    await expect(rotateCredential(options(backend, '   ', verify))).rejects.toThrow(/replacement.*required/i);
    expect(backend.reads).toEqual([]);
    expect(backend.writes).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not verify after a credential write failure', async () => {
    const backend = new FakeBackend();
    const failure = new Error('write failed');
    backend.writeError = failure;
    const verify = vi.fn(async () => undefined);
    await expect(rotateCredential(options(backend, 'new-code', verify))).rejects.toBe(failure);
    expect(verify).not.toHaveBeenCalled();
  });

  it('disposes the snapshot handle when its value is malformed', async () => {
    const backend = new FakeBackend();
    const handle = new FakeHandle(42);
    backend.read = vi.fn(() => handle);
    await expect(rotateCredential(options(backend, 'new-code', async () => undefined))).rejects.toThrow(/invalid value/i);
    expect(handle.disposed).toBe(true);
    expect(backend.writes).toEqual([]);
  });

  it.each(['restore', 'delete'] as const)('uses a fixed secret-free error when %s rollback fails', async (mode) => {
    const backend = new FakeBackend();
    if (mode === 'restore') backend.values.set(target, 'old-secret-value');
    else backend.deleteError = new Error('delete leaked new-secret-value');
    if (mode === 'restore') {
      let writes = 0;
      backend.write = (writeTarget, secret) => {
        writes += 1;
        if (writes === 2) throw new Error('restore leaked old-secret-value');
        backend.values.set(writeTarget, secret);
      };
    }
    const verification = new Error('verification failed');
    let caught: unknown;
    try {
      await rotateCredential(options(backend, 'new-secret-value', async () => { throw verification; }));
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(CredentialRollbackError);
    expect((caught as Error).message).toBe('Credential verification failed and rollback failed');
    expect((caught as Error).message).not.toMatch(/old-secret-value|new-secret-value/);
    expect((caught as Error).cause).toBe(verification);
  });
});
