import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('public release surface', () => {
  it('documents the supported providers, safe-send boundary, and clone-first setup', () => {
    const readme = read('README.md');
    for (const heading of [
      '## Features',
      '## Supported providers',
      '## MCP tools',
      '## Quick start',
      '## Gmail setup',
      '## QQ Mail setup',
      '## Proxy setup',
      '## Security model',
      '## Architecture',
      '## Troubleshooting',
      '## FAQ',
      '## Roadmap',
      '## Contributing',
      '## License',
    ]) {
      expect(readme).toContain(heading);
    }
    expect(readme).toMatch(/Windows Credential Manager/);
    expect(readme).toMatch(/preview[\s\S]{0,160}confirm/i);
    expect(readme).not.toMatch(/npx\s+-y\s+imap-mcp-server/);
    expect(readme).not.toMatch(/raw\.githubusercontent\.com\/nikolausm/);
    expect(readme).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });

  it('publishes machine-readable mail-agent metadata without claiming an unpublished package', () => {
    const pkg = JSON.parse(read('package.json')) as {
      description?: string;
      keywords?: string[];
      files?: string[];
    };
    expect(pkg.description).toMatch(/Gmail/);
    expect(pkg.description).toMatch(/QQ Mail/);
    expect(pkg.keywords).toEqual(expect.arrayContaining([
      'gmail-mcp',
      'qq-mail-mcp',
      'email-mcp-server',
      'email-agent',
      'oauth2',
    ]));
    expect(pkg.files).toEqual(expect.arrayContaining([
      'SECURITY.md',
      'docs/agent-integration.md',
    ]));
  });

  it('keeps install helpers local, non-destructive, and aligned with the Node floor', () => {
    for (const path of ['install.ps1', 'install.sh']) {
      const script = read(path);
      expect(script).toMatch(/22\.12/);
      expect(script).not.toMatch(/git\s+(clone|pull)/);
      expect(script).not.toMatch(/claude_desktop_config\.json/);
      expect(script).not.toMatch(/imap_add_account[\s\S]{0,80}(password|credential)/i);
    }
  });

  it('ships an agent-readable contract and current security model', () => {
    const agentGuide = read('docs/agent-integration.md');
    const security = read('SECURITY.md');
    expect(agentGuide).toMatch(/read-only/i);
    expect(agentGuide).toContain('imap_confirm_send');
    expect(agentGuide).toMatch(/Windows Credential Manager/);
    expect(security).toMatch(/refresh token/i);
    expect(security).toMatch(/QQ Mail authorization code/i);
    expect(security).toMatch(/preview[\s\S]{0,160}confirm/i);
    expect(security).not.toMatch(/Gmail[\s\S]{0,80}app-specific password/i);
  });
});

  it('uses the approved independent GitHub identity and keeps publishing disabled', () => {
    const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
    expect(pkg).toMatchObject({ name: 'mail-agent-mcp', version: '0.1.0' });
    expect(pkg).toMatchObject({
      mcpName: 'io.github.SinoEdwards/mail-agent-mcp',
      repository: {
        type: 'git',
        url: 'git+https://github.com/SinoEdwards/mail-agent-mcp.git',
      },
      homepage: 'https://github.com/SinoEdwards/mail-agent-mcp#readme',
      bugs: { url: 'https://github.com/SinoEdwards/mail-agent-mcp/issues' },
    });
    const server = JSON.parse(read('server.json')) as Record<string, unknown>;
    expect(server).toMatchObject({
      name: 'io.github.SinoEdwards/mail-agent-mcp',
      version: '0.1.0',
      repository: { url: 'https://github.com/SinoEdwards/mail-agent-mcp' },
    });
    expect(() => read('.github/workflows/release.yml')).toThrow();
    expect(read('.github/workflow-drafts/release.yml')).not.toMatch(/npm publish|mcp-publisher|id-token:\s*write/i);
  });

  it('keeps public CI read-only, credential-free, and reproducible', () => {
    const ci = read('.github/workflows/ci.yml');
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(ci).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(ci).toMatch(/node-version: \[22\.x, 24\.x\]/);
    for (const command of [
      'npm ci',
      'npm test',
      'npm run build',
      'npm run lint',
      'git diff --check',
      'npm run check:secrets',
      'npm audit --omit=dev --audit-level=high',
      'npm audit --audit-level=high',
      'npm pack --dry-run',
    ]) expect(ci).toContain(command);
    for (const output of ['dist/index.js', 'dist/setup.js', 'dist/enroll.js']) {
      expect(ci).toContain(output);
    }
    expect(ci).not.toMatch(/skip_tests|test:coverage|contents: write|pull-requests: write/i);
    expect(ci).not.toMatch(/GMAIL|QQ|CLIENT_SECRET|AUTHORIZATION_CODE|CREDENTIAL/i);
    expect(pkg.scripts?.['check:secrets']).toBe('node scripts/check-release-secrets.mjs');
    expect(read('scripts/check-release-secrets.mjs')).toContain(
      "'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']",
    );
  });

  it('has no active publisher, auto-merge, or private-author automation', () => {
    for (const path of [
      '.github/workflows/release.yml',
      '.github/workflows/dependabot-auto-merge.yml',
      '.github/workflows/claude.yml',
      '.github/workflows/claude-code-review.yml',
    ]) expect(() => read(path)).toThrow();
  });
