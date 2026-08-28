export interface SecretHandle {
  read(): unknown;
  dispose(): void;
}

export interface CredentialBackend {
  read(target: string): SecretHandle | undefined;
  write(target: string, secret: string): void;
  delete(target: string): boolean;
}

export type CredentialProvider = 'qq' | 'gmail';

function normalizedAccount(account: string): string {
  const normalized = account.trim();
  if (!normalized || /[:\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error('Invalid account identifier for credential target');
  }
  return normalized;
}

export function credentialTarget(provider: CredentialProvider, account: string): string {
  const normalized = normalizedAccount(account);
  return provider === 'qq'
    ? `MailAgentMCP:qq:${normalized}:authorization_code`
    : `MailAgentMCP:gmail:${normalized}:refresh_token`;
}

export function gmailClientSecretTarget(account: string): string {
  return `MailAgentMCP:gmail:${normalizedAccount(account)}:client_secret`;
}

export function legacyCredentialTarget(provider: CredentialProvider, account: string): string {
  const normalized = normalizedAccount(account);
  return provider === 'qq'
    ? `CodexLab:QQMail:${normalized}:authorization_code`
    : `CodexLab:Gmail:${normalized}:refresh_token`;
}

export function legacyGmailClientSecretTarget(account: string): string {
  return `CodexLab:Gmail:${normalizedAccount(account)}:client_secret`;
}

export function credentialTargetsForAccount(
  provider: CredentialProvider,
  account: string,
): readonly string[] {
  return [credentialTarget(provider, account), legacyCredentialTarget(provider, account)];
}

export function gmailClientSecretTargetsForAccount(account: string): readonly string[] {
  return [gmailClientSecretTarget(account), legacyGmailClientSecretTarget(account)];
}
