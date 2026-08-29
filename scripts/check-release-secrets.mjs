import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const lineRules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['google-client-id', /\b\d{12,}-[0-9A-Za-z_-]{20,}\.apps\.googleusercontent\.com\b/],
  ['credential-url', /\b(?:https?|socks5?):\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/i],
  ['personal-windows-path', /\b[A-Za-z]:\\Users\\(?!Public(?:\\|\b)|Default(?:\\|\b)|runneradmin(?:\\|\b)|example(?:\\|\b)|user(?:\\|\b)|test(?:\\|\b))[^\\\s]+\\/i],
];

const staticSecretFields = [
  ['password', 'static-password'],
  ['authorizationCode', 'static-authorizationCode'],
  ['clientSecret', 'static-clientSecret'],
  ['refreshToken', 'static-refreshToken'],
  ['accessToken', 'static-accessToken'],
  ['encryptionKey', 'static-encryption-key'],
  ['mockEncryptionKey', 'static-encryption-key'],
];

function quotedFieldPattern(field) {
  return new RegExp(`(?:["']?\\b${field}\\b["']?)\\s*[:=]\\s*(["'\\x60])([^"'\\x60\\r\\n]{8,})\\1`, 'i');
}

export function scanText(text) {
  const lines = text.split(/\r?\n/);
  const findings = [];
  const add = (category, line) => {
    if (!findings.some((finding) => finding.category === category && finding.line === line)) {
      findings.push({ category, line });
    }
  };

  for (const [index, line] of lines.entries()) {
    for (const [category, pattern] of lineRules) {
      if (pattern.test(line)) add(category, index + 1);
    }
    for (const [field, category] of staticSecretFields) {
      if (quotedFieldPattern(field).test(line)) add(category, index + 1);
    }
  }

  for (const [index, line] of lines.entries()) {
    if (!quotedFieldPattern('password').test(line)) continue;
    const context = lines.slice(Math.max(0, index - 12), Math.min(lines.length, index + 13)).join('\n');
    const hasSmtpContext = /\bsmtp\b|smtp\.[a-z0-9.-]+/i.test(context);
    const hasStaticUser = /(?:["']?user["']?)\s*:\s*(["'\x60])[^"'\x60\r\n]+\1/i.test(context);
    if (hasSmtpContext && hasStaticUser) add('smtp-credential-pair', index + 1);
  }

  return findings;
}

function verifyRules() {
  const dangerous = [
    ['private-key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['github-token', ['ghp_', 'A'.repeat(36)].join('')],
    ['google-client-id', ['123456789012-', 'a'.repeat(24), '.apps.googleusercontent.com'].join('')],
    ['credential-url', ['https://user', ':password@example.invalid'].join('')],
    ['personal-windows-path', ['C:', '\\Users\\', 'RealName\\mail'].join('')],
    ['static-password', ['pass', 'word: ', "'", 'static-fixture-value', "'"].join('')],
    ['smtp-credential-pair', [
      "smtp: { user: '", 'sender@example.test', "', ",
      'pass', "word: '", 'static-fixture-value', "' }",
    ].join('')],
  ];
  for (const [category, fixture] of dangerous) {
    if (!scanText(fixture).some((finding) => finding.category === category)) {
      throw new Error(`secret rule self-test failed: ${category}`);
    }
  }
  for (const fixture of [
    'https://example.invalid',
    'C:\\Users\\example\\mail',
    '<CLIENT_ID>',
    "const SYNTHETIC_PASSWORD = ['synthetic', 'password'].join('-');",
  ]) {
    if (scanText(fixture).length) throw new Error('safe secret fixture was rejected');
  }
}

verifyRules();
const files = execFileSync(
  'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' },
).split('\0').filter(Boolean);
const findings = [];
for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  for (const finding of scanText(text)) findings.push({ ...finding, file });
}

if (findings.length) {
  console.error('Potential release secrets detected (values intentionally omitted):');
  for (const { category, file, line } of findings) console.error(`${category}: ${file}:${line}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${files.length} release-candidate files.`);
}
