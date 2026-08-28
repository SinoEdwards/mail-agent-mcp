import koffi from 'koffi';
import type { CredentialBackend, SecretHandle } from './credential-backend.js';

export const CRED_TYPE_GENERIC = 1;
export const CRED_PERSIST_LOCAL_MACHINE = 2;
export const ERROR_NOT_FOUND = 1168;
export const CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560;

export interface WinCredReadSuccess { pointer: unknown; blob: Buffer }
export type WinCredReadResult = WinCredReadSuccess | { errorCode: number };
export interface WinCredBoolResult { ok: boolean; errorCode: number }
export interface WinCredWriteInput {
  flags: number; type: number; targetName: string; credentialBlob: Buffer;
  persist: number; userName: string;
}
export interface WinCredNative {
  credRead(target: string, type: number, flags: number): WinCredReadResult;
  credWrite(credential: WinCredWriteInput, flags: number): WinCredBoolResult;
  credDelete(target: string, type: number, flags: number): WinCredBoolResult;
  credFree(pointer: unknown): void;
}

function winError(operation: string, code: number): Error {
  return new Error(`${operation} failed with Windows error ${code}`);
}

function validateBlob(blob: Buffer): void {
  if (blob.length === 0) throw new Error('Credential blob is empty');
  if (blob.length > CRED_MAX_CREDENTIAL_BLOB_SIZE) throw new Error(`Credential blob exceeds ${CRED_MAX_CREDENTIAL_BLOB_SIZE} bytes`);
  if (blob.length % 2 !== 0) throw new Error('Credential blob is not valid UTF-16LE');
}

class BufferSecretHandle implements SecretHandle {
  private disposed = false;
  constructor(private readonly secret: Buffer) {}
  read(): unknown {
    if (this.disposed) throw new Error('Credential handle has been disposed');
    return this.secret.toString('utf16le').replace(/\0+$/u, '');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.secret.fill(0);
  }
}

let defaultWinCredNative: WinCredNative | undefined;

function getDefaultWinCredNative(): WinCredNative {
  defaultWinCredNative ??= createKoffiWinCredNative();
  return defaultWinCredNative;
}

export class WindowsCredentialBackend implements CredentialBackend {
  private readonly native: WinCredNative;
  constructor(native?: WinCredNative) {
    this.native = native ?? getDefaultWinCredNative();
  }
  read(target: string): SecretHandle | undefined {
    const result = this.native.credRead(target, CRED_TYPE_GENERIC, 0);
    if ('errorCode' in result) {
      if (result.errorCode === ERROR_NOT_FOUND) return undefined;
      throw winError('CredReadW', result.errorCode);
    }
    let transferred = false;
    try {
      validateBlob(result.blob);
      transferred = true;
      return new BufferSecretHandle(result.blob);
    } finally {
      this.native.credFree(result.pointer);
      if (!transferred) result.blob.fill(0);
    }
  }
  write(target: string, secret: string): void {
    if (!secret) throw new Error('Credential secret must not be empty');
    const blob = Buffer.from(secret, 'utf16le');
    try {
      validateBlob(blob);
      const result = this.native.credWrite({ flags: 0, type: CRED_TYPE_GENERIC, targetName: target, credentialBlob: blob, persist: CRED_PERSIST_LOCAL_MACHINE, userName: target }, 0);
      if (!result.ok) throw winError('CredWriteW', result.errorCode);
    } finally { blob.fill(0); }
  }
  delete(target: string): boolean {
    const result = this.native.credDelete(target, CRED_TYPE_GENERIC, 0);
    if (result.ok) return true;
    if (result.errorCode === ERROR_NOT_FOUND) return false;
    throw winError('CredDeleteW', result.errorCode);
  }
}

export class UnavailableCredentialBackend implements CredentialBackend {
  constructor(private readonly platform = process.platform) {}
  private unavailable(): never { throw new Error(`Windows Credential Manager is unavailable on platform ${this.platform}`); }
  read(_target: string): SecretHandle | undefined { return this.unavailable(); }
  write(_target: string, _secret: string): void { this.unavailable(); }
  delete(_target: string): boolean { return this.unavailable(); }
}

/** WinCred owns the native allocation only until this facade copies the blob; the facade frees it immediately. */
export function createKoffiWinCredNative(): WinCredNative {
  if (process.platform !== 'win32') throw new Error(`Windows Credential Manager is unavailable on platform ${process.platform}`);
  const FILETIME = koffi.struct('FILETIME', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' });
  const CREDENTIALW = koffi.struct('CREDENTIALW', {
    Flags: 'uint32', Type: 'uint32', TargetName: 'str16', Comment: 'str16', LastWritten: FILETIME,
    CredentialBlobSize: 'uint32', CredentialBlob: koffi.pointer('uint8'), Persist: 'uint32', AttributeCount: 'uint32',
    Attributes: koffi.pointer('void'), TargetAlias: 'str16', UserName: 'str16',
  });
  const credentialPointer = koffi.pointer(CREDENTIALW);
  const advapi32 = koffi.load('Advapi32.dll');
  const kernel32 = koffi.load('Kernel32.dll');
  const credReadW = advapi32.func('__stdcall', 'CredReadW', 'int32', ['str16', 'uint32', 'uint32', koffi.out(koffi.pointer(credentialPointer))]);
  const credWriteW = advapi32.func('__stdcall', 'CredWriteW', 'int32', [credentialPointer, 'uint32']);
  const credDeleteW = advapi32.func('__stdcall', 'CredDeleteW', 'int32', ['str16', 'uint32', 'uint32']);
  const credFree = advapi32.func('__stdcall', 'CredFree', 'void', [koffi.pointer('void')]);
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);
  return {
    credRead(target, type, flags) {
      const output: unknown[] = [null];
      const ok = Number(credReadW(target, type, flags, output));
      if (ok === 0) return { errorCode: Number(getLastError()) };
      const pointer = output[0];
      if (!pointer) throw new Error('CredReadW returned a null credential pointer');
      try {
        const decoded = koffi.decode(pointer, CREDENTIALW) as { CredentialBlobSize: number; CredentialBlob: unknown };
        const size = Number(decoded.CredentialBlobSize);
        if (!Number.isInteger(size) || size <= 0 || size > CRED_MAX_CREDENTIAL_BLOB_SIZE || size % 2 !== 0 || !decoded.CredentialBlob) throw new Error('Credential blob metadata is invalid');
        return { pointer, blob: Buffer.from(koffi.view(decoded.CredentialBlob, size)) };
      } catch (error) { credFree(pointer); throw error; }
    },
    credWrite(credential, flags) {
      const ok = Number(credWriteW({ Flags: credential.flags, Type: credential.type, TargetName: credential.targetName, Comment: null, LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 }, CredentialBlobSize: credential.credentialBlob.length, CredentialBlob: credential.credentialBlob, Persist: credential.persist, AttributeCount: 0, Attributes: null, TargetAlias: null, UserName: credential.userName }, flags));
      return ok !== 0 ? { ok: true, errorCode: 0 } : { ok: false, errorCode: Number(getLastError()) };
    },
    credDelete(target, type, flags) {
      const ok = Number(credDeleteW(target, type, flags));
      return ok !== 0 ? { ok: true, errorCode: 0 } : { ok: false, errorCode: Number(getLastError()) };
    },
    credFree(pointer) { credFree(pointer); },
  };
}
