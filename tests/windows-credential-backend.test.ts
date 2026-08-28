import { describe, expect, it } from 'vitest';
import type { WinCredNative, WinCredReadResult, WinCredWriteInput } from '../src/credentials/windows-credential-backend.js';
import {
  CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
  ERROR_NOT_FOUND, UnavailableCredentialBackend, WindowsCredentialBackend,
} from '../src/credentials/windows-credential-backend.js';

class FakeNative implements WinCredNative {
  readResult: WinCredReadResult = { errorCode: ERROR_NOT_FOUND };
  readError = ERROR_NOT_FOUND;
  writeResult = { ok: true, errorCode: 0 };
  deleteResult = { ok: true, errorCode: 0 };

  reads: unknown[][] = [];
  writes: Array<{ input: WinCredWriteInput; flags: number; raw: Buffer }> = [];
  deletes: unknown[][] = [];
  frees: unknown[] = [];
  credRead(target: string, type: number, flags: number) { this.reads.push([target, type, flags]); return this.readResult; }
  credWrite(input: WinCredWriteInput, flags: number) { this.writes.push({ input: { ...input, credentialBlob: Buffer.from(input.credentialBlob) }, flags, raw: input.credentialBlob }); return this.writeResult; }
  credDelete(target: string, type: number, flags: number) { this.deletes.push([target, type, flags]); return this.deleteResult; }
  credFree(pointer: unknown) { this.frees.push(pointer); }

}

describe('WindowsCredentialBackend', () => {
  it('reads UTF-16LE, CredFrees once, and zeroizes on idempotent dispose', () => {
    const native = new FakeNative();
    const blob = Buffer.from('qq-code', 'utf16le');
    const pointer = {};
    native.readResult = { pointer, blob };
    const handle = new WindowsCredentialBackend(native).read('target');
    expect(native.reads).toEqual([['target', CRED_TYPE_GENERIC, 0]]);
    expect(native.frees).toEqual([pointer]);
    expect(handle?.read()).toBe('qq-code');
    handle?.dispose(); handle?.dispose();
    expect(blob.every((byte) => byte === 0)).toBe(true);
    expect(() => handle?.read()).toThrow(/disposed/i);
    expect(native.frees).toEqual([pointer]);
  });

  it.each([Buffer.from([1]), Buffer.alloc(CRED_MAX_CREDENTIAL_BLOB_SIZE + 2)])('rejects malformed blobs, frees once, and zeroizes', (blob) => {
    const native = new FakeNative(); const pointer = {};
    native.readResult = { pointer, blob };
    expect(() => new WindowsCredentialBackend(native).read('target')).toThrow(/UTF-16LE|exceeds/i);
    expect(native.frees).toEqual([pointer]);
    expect(blob.every((byte) => byte === 0)).toBe(true);
  });

  it('returns undefined only for not found and surfaces other read errors', () => {
    const missing = new FakeNative(); missing.readError = ERROR_NOT_FOUND;
    expect(new WindowsCredentialBackend(missing).read('missing')).toBeUndefined();
    const denied = new FakeNative(); denied.readResult = { errorCode: 5 };
    expect(() => new WindowsCredentialBackend(denied).read('denied')).toThrow(/CredReadW.*5/);
  });

  it('writes generic local-machine UTF-16LE and zeroizes the transient buffer', () => {
    const native = new FakeNative();
    new WindowsCredentialBackend(native).write('target', 'secret');
    const write = native.writes[0];
    expect(write.flags).toBe(0);
    expect(write.input).toMatchObject({ flags: 0, type: CRED_TYPE_GENERIC, targetName: 'target', persist: CRED_PERSIST_LOCAL_MACHINE, userName: 'target' });
    expect(write.input.credentialBlob.toString('utf16le')).toBe('secret');
    expect(write.raw.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects values over 2560 bytes before native write', () => {
    const native = new FakeNative();
    expect(() => new WindowsCredentialBackend(native).write('target', 'x'.repeat(1281))).toThrow(/2560/);
    expect(native.writes).toEqual([]);
  });

  it('distinguishes a missing delete and fails explicitly off Windows', () => {
    const native = new FakeNative(); native.deleteResult = { ok: false, errorCode: ERROR_NOT_FOUND };
    expect(new WindowsCredentialBackend(native).delete('missing')).toBe(false);
    const unavailable = new UnavailableCredentialBackend('linux');
    expect(() => unavailable.read('target')).toThrow(/unavailable.*linux/i);
  });

  it('uses facade-captured error codes for write and delete', () => {
    const native = new FakeNative();
    native.writeResult = { ok: false, errorCode: 32 };
    expect(() => new WindowsCredentialBackend(native).write('target', 's')).toThrow(/CredWriteW.*32/);
    native.deleteResult = { ok: false, errorCode: 32 };
    expect(() => new WindowsCredentialBackend(native).delete('target')).toThrow(/CredDeleteW.*32/);
  });
});
