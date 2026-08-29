import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scanner = resolve('scripts/check-release-secrets.mjs');
const temporaryDirectories: string[] = [];

function scan(source: string) {
  const directory = mkdtempSync(resolve(tmpdir(), 'mail-agent-secret-scan-'));
  temporaryDirectories.push(directory);
  writeFileSync(resolve(directory, 'fixture.ts'), source, 'utf8');
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['add', 'fixture.ts'], { cwd: directory });
  return spawnSync(process.execPath, [scanner], { cwd: directory, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release secret scanner', () => {
  it('detects adjacent SMTP user/password literals without printing their values', () => {
    const passwordField = ['pass', 'word'].join('');
    const staticValue = ['SYNTHETIC', 'but-static-password'].join('-');
    const result = scan([
      "const smtp = { host: 'smtp.example.test',",
      "  user: 'sender@example.test',",
      `  ${passwordField}: '${staticValue}' };`,
    ].join('\n'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smtp-credential-pair: fixture.ts:3');
    expect(result.stderr).not.toContain('sender@example.test');
    expect(result.stderr).not.toContain(staticValue);
  });

  it.each(['password', 'authorizationCode', 'clientSecret', 'refreshToken', 'accessToken'])(
    'detects a static high-risk %s literal',
    (field) => {
      const value = `SYNTHETIC-static-${field}-value`;
      const result = scan(`const fixture = { ${field}: '${value}' };`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`static-${field}: fixture.ts:1`);
      expect(result.stderr).not.toContain(value);
    },
  );

  it('detects a static encryption-key fixture without printing its value', () => {
    const field = ['mock', 'EncryptionKey'].join('');
    const value = ['0123456789abcdef', '0123456789abcdef'].join('');
    const result = scan(`const ${field} = '${value}';`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('static-encryption-key: fixture.ts:1');
    expect(result.stderr).not.toContain(value);
  });

  it('allows explicitly synthetic values assembled at runtime', () => {
    const result = scan([
      "const SYNTHETIC_PASSWORD = ['synthetic', 'password'].join('-');",
      "const fixture = { password: SYNTHETIC_PASSWORD };",
    ].join('\n'));
    expect(result.status).toBe(0);
  });
});
