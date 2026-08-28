import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const rules = [
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

function matches(text) {
  return rules.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
}

function verifyRules() {
  const dangerous = [
    ['private-key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['github-token', ['ghp_', 'A'.repeat(36)].join('')],
    ['google-client-id', ['123456789012-', 'a'.repeat(24), '.apps.googleusercontent.com'].join('')],
    ['credential-url', ['https://user', ':password@example.invalid'].join('')],
    ['personal-windows-path', ['C:', '\\Users\\', 'RealName\\mail'].join('')],
  ];
  for (const [category, fixture] of dangerous) {
    if (!matches(fixture).includes(category)) throw new Error(`secret rule self-test failed: ${category}`);
  }
  for (const fixture of ['https://example.invalid', 'C:\\Users\\example\\mail', '<CLIENT_ID>']) {
    if (matches(fixture).length) throw new Error('safe secret fixture was rejected');
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
  for (const category of matches(text)) findings.push({ category, file });
}

if (findings.length) {
  console.error('Potential release secrets detected (values intentionally omitted):');
  for (const { category, file } of findings) console.error(`${category}: ${file}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${files.length} release-candidate files.`);
}
