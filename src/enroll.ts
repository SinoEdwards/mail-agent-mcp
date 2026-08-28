import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import open from 'open';
import { AccountAuthResolver } from './credentials/account-auth.js';
import { AccountEnrollmentService } from './credentials/account-enrollment.js';
import type { CredentialBackend } from './credentials/credential-backend.js';
import { credentialTargetsForAccount, gmailClientSecretTargetsForAccount } from './credentials/credential-backend.js';
import { CredentialRollbackError, rotateCredential, type CredentialRotationOptions } from './credentials/credential-rotation.js';
import { runGmailOAuthLoopback } from './credentials/gmail-oauth-loopback.js';
import { createGmailAccessTokenExchange } from './credentials/gmail-token-exchange.js';
import { WindowsCredentialBackend } from './credentials/windows-credential-backend.js';
import { AccountManager } from './services/account-manager.js';
import { ImapService } from './services/imap-service.js';
import type { ImapAccount } from './types/index.js';

type Provider = 'qq' | 'gmail';

export type EnrollmentPrompt = (
  label: string,
  options?: { secret?: boolean; defaultValue?: string },
) => Promise<string>;

export interface EnrollmentCliDependencies {
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  getAccounts?: () => ImapAccount[];
  credentials?: CredentialBackend;
  prompt?: EnrollmentPrompt;
  rotateCredential?: (options: CredentialRotationOptions) => Promise<void>;
  runGmailOAuth?: typeof runGmailOAuthLoopback;
  openBrowser?: (url: string) => void | Promise<void>;
  authenticateOnly?: (account: ImapAccount, credentials: CredentialBackend) => Promise<void>;
  writeOutput?: (text: string) => void;
}

const activeQqRepairs = new Set<string>();
const activeGmailRepairs = new Set<string>();

function readStoredSecret(credentials: CredentialBackend, target: string): string {
  const handle = credentials.read(target);
  if (!handle) throw new Error('Stored credential is missing');
  try {
    const value = handle.read();
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Stored credential is invalid');
    }
    return value.trim();
  } finally {
    handle.dispose();
  }
}


class MutedPromptOutput extends Writable {
  muted = false;
  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.muted) {
      callback();
      return;
    }
    process.stdout.write(chunk, encoding, callback);
  }
}

function parseProvider(value: string | undefined): Provider | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'qq' || normalized === 'gmail' ? normalized : undefined;
}

export async function runEnrollmentCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: EnrollmentCliDependencies = {},
): Promise<void> {
  const writeOutput = dependencies.writeOutput ?? ((text: string) => process.stdout.write(text));
  const command = argv[0]?.trim().toLowerCase();
  if (command === '--help' || command === '-h') {
    writeOutput(
      'Usage: mail-agent-enroll <qq|gmail|qq-repair [account-id-or-name]|gmail-repair [account-id-or-name]>\n'
      + '\n'
      + '  qq         Enroll a QQ Mail account using an authorization code\n'
      + '  gmail      Enroll a Gmail account using installed-app OAuth\n'
      + '  qq-repair  Replace and verify a selected credential-backed QQ account\n'
      + '  gmail-repair  Reauthorize and verify a selected Gmail account\n',
    );
    return;
  }

  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw new Error('Secure enrollment currently requires Windows Credential Manager');
  }

  if (
    argv[0]?.trim().toLowerCase() === 'qq-repair'
    && !dependencies.prompt
    && !(dependencies.stdinIsTTY ?? process.stdin.isTTY)
  ) {
    throw new Error('QQ credential repair requires an interactive terminal for secret input');
  }

  let output: MutedPromptOutput | undefined;
  let readline: ReturnType<typeof createInterface> | undefined;
  let ask = dependencies.prompt;
  if (!ask) {
    output = new MutedPromptOutput();
    readline = createInterface({
      input: process.stdin,
      output,
      terminal: Boolean(process.stdin.isTTY),
    });
    ask = async (
      label: string,
      options: { secret?: boolean; defaultValue?: string } = {},
    ): Promise<string> => {
      for (;;) {
        output!.muted = false;
        const suffix = options.defaultValue ? ` [${options.defaultValue}]` : '';
        const pending = readline!.question(`${label}${suffix}: `);
        if (options.secret) output!.muted = true;
        try {
          const answer = (await pending).trim();
          if (options.secret) writeOutput('\n');
          const value = answer || options.defaultValue || '';
          if (value) return value;
          writeOutput('A value is required.\n');
        } finally {
          output!.muted = false;
        }
      }
    };
  }

  try {
    if (argv[0]?.trim().toLowerCase() === 'qq-repair') {
      if (argv.length > 2) {
        throw new Error('QQ credential repair accepts at most one account selector');
      }
      const accounts = dependencies.getAccounts
        ? dependencies.getAccounts()
        : new AccountManager().getAllAccounts();
      const eligible = accounts.filter((account) =>
        account.auth?.kind === 'credential' && account.auth.provider === 'qq',
      );
      const selector = argv[1]?.trim();
      const selected = selector
        ? eligible.filter((candidate) =>
          candidate.id === selector || candidate.name === selector || candidate.user === selector)
        : eligible;
      if (selected.length !== 1) {
        throw new Error(
          selector
            ? 'QQ credential repair account selector must match exactly one eligible account'
            : 'QQ credential repair requires an account selector when zero or multiple eligible accounts exist',
        );
      }
      const account = selected[0]!;
      const expectedTargets = credentialTargetsForAccount('qq', account.user);
      const selectedTarget = account.auth!.credentialTarget;
      if (!expectedTargets.includes(selectedTarget)) {
        throw new Error('QQ credential target mismatch');
      }
      if (activeQqRepairs.has(selectedTarget)) {
        throw new Error('QQ credential repair is already in progress');
      }

      activeQqRepairs.add(selectedTarget);
      try {
        const replacement = await ask('QQ Mail authorization code', { secret: true });
        const credentials = dependencies.credentials ?? new WindowsCredentialBackend();
        const verify = async (): Promise<void> => {
          if (dependencies.authenticateOnly) {
            await dependencies.authenticateOnly(account, credentials);
            return;
          }
          const resolver = new AccountAuthResolver(credentials);
          await new ImapService(resolver).authenticateOnly(account);
        };
        await (dependencies.rotateCredential ?? rotateCredential)({
          credentials,
          target: selectedTarget,
          expectedTarget: selectedTarget,
          replacement,
          verify,
        });
        writeOutput('QQ Mail credential repaired successfully.\n');
      } catch (error) {
        if (error instanceof CredentialRollbackError) {
          throw new Error(
            'QQ credential repair failed; credential state may be inconsistent and repair must be rerun',
          );
        }
        throw new Error('QQ credential repair failed; the previous credential was restored');
      } finally {
        activeQqRepairs.delete(selectedTarget);
      }
      return;
    }

    if (argv[0]?.trim().toLowerCase() === 'gmail-repair') {
      if (argv.length > 2) {
        throw new Error('Gmail repair accepts at most one account selector');
      }
      const accounts = dependencies.getAccounts
        ? dependencies.getAccounts()
        : new AccountManager().getAllAccounts();
      const eligible = accounts.filter((account) =>
        account.auth?.kind === 'oauth2' && account.auth.provider === 'gmail',
      );
      const selector = argv[1]?.trim();
      const selected = selector
        ? eligible.filter((candidate) =>
          candidate.id === selector || candidate.name === selector || candidate.user === selector)
        : eligible;
      if (selected.length !== 1) {
        throw new Error(
          selector
            ? 'Gmail repair account selector must match exactly one eligible account'
            : 'Gmail repair requires an account selector when zero or multiple eligible accounts exist',
        );
      }
      const account = selected[0]!;
      const auth = account.auth!;
      const clientId = auth.kind === 'oauth2' ? auth.clientId?.trim() : undefined;
      if (
        auth.kind !== 'oauth2'
        || !clientId
        || !credentialTargetsForAccount('gmail', account.user).includes(auth.credentialTarget)
        || (auth.clientSecretTarget !== undefined
          && !gmailClientSecretTargetsForAccount(account.user).includes(auth.clientSecretTarget))
      ) {
        throw new Error('Gmail credential target mismatch');
      }
      const selectedTarget = auth.credentialTarget;
      if (activeGmailRepairs.has(selectedTarget)) {
        throw new Error('Gmail repair is already in progress');
      }

      activeGmailRepairs.add(selectedTarget);
      try {
        const credentials = dependencies.credentials ?? new WindowsCredentialBackend();
        const clientSecret = auth.clientSecretTarget
          ? readStoredSecret(credentials, auth.clientSecretTarget)
          : undefined;
        writeOutput('Opening Gmail authorization in your browser...\n');
        const oauth = dependencies.runGmailOAuth ?? runGmailOAuthLoopback;
        const { refreshToken } = await oauth({
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          loginHint: account.user,
          openBrowser: dependencies.openBrowser
            ?? (async (url) => { await open(url); }),
        });
        const verify = async (): Promise<void> => {
          if (dependencies.authenticateOnly) {
            await dependencies.authenticateOnly(account, credentials);
            return;
          }
          const resolver = new AccountAuthResolver(
            credentials,
            createGmailAccessTokenExchange({ credentials }),
          );
          await new ImapService(resolver).authenticateOnly(account);
        };
        await (dependencies.rotateCredential ?? rotateCredential)({
          credentials,
          target: selectedTarget,
          expectedTarget: selectedTarget,
          replacement: refreshToken,
          verify,
        });
        writeOutput('Gmail account reauthorized successfully.\n');
      } catch (error) {
        if (error instanceof CredentialRollbackError) {
          throw new Error(
            'Gmail repair failed; credential state may be inconsistent and repair must be rerun',
          );
        }
        throw new Error('Gmail repair failed; the previous credential was restored');
      } finally {
        activeGmailRepairs.delete(selectedTarget);
      }
      return;
    }

    let provider = parseProvider(argv[0]);
    while (!provider) {
      provider = parseProvider(await ask('Provider (qq or gmail)'));
      if (!provider) writeOutput('Provider must be qq or gmail.\n');
    }

    const email = await ask('Email address');
    const name = await ask('Account name', { defaultValue: email });
    const enrollment = new AccountEnrollmentService(
      dependencies.credentials ?? new WindowsCredentialBackend(),
      new AccountManager(),
    );

    if (provider === 'qq') {
      const authorizationCode = await ask('QQ Mail authorization code', {
        secret: true,
      });
      const account = await enrollment.enrollQq({
        email,
        name,
        authorizationCode,
      });
      writeOutput(`QQ Mail account enrolled: ${account.id}\n`);
      return;
    }

    const clientId = await ask('Gmail OAuth desktop client ID');
    const clientSecret = await ask('Gmail OAuth client secret', {
      secret: true,
    });
    writeOutput('Opening Gmail authorization in your browser...\n');
    const { refreshToken } = await runGmailOAuthLoopback({
      clientId,
      clientSecret,
      loginHint: email,
      openBrowser: async (url) => { await open(url); },
    });
    const account = await enrollment.enrollGmail({
      email,
      name,
      clientId,
      clientSecret,
      refreshToken,
    });
    writeOutput(`Gmail account enrolled: ${account.id}\n`);
  } finally {
    if (output) output.muted = false;
    readline?.close();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runEnrollmentCli().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Account enrollment failed';
    process.stderr.write(`Enrollment failed: ${message}\n`);
    process.exitCode = 1;
  });
}
