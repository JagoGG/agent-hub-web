import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const SAFE_EMAIL_DOMAINS = new Set(['example.com', 'users.noreply.github.com']);

const CONTENT_RULES = [
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub access token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['OpenAI-style API key', /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{20,}/],
  ['JSON web token', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['embedded URL credentials', /https?:\/\/[^/\s:@]+:[^@\s/]+@/],
  ['local user profile path', /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\s'"<>]+/],
];

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

export function auditRelativePath(filePath) {
  const normalized = normalizePath(filePath);
  const findings = [];

  if (/(^|\/)\.env(?:\.|$)/i.test(normalized) && !/\.env\.(?:example|sample|template)$/i.test(normalized)) {
    findings.push('environment file');
  }
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(normalized)) findings.push('credential container');
  if (/\.(?:db|sqlite|sqlite3|log)$/i.test(normalized)) findings.push('runtime data file');
  if (/(^|\/)(?:\.data|data|storage)\/.*\.json$/i.test(normalized)) findings.push('runtime JSON data');
  if (/(^|\/)(?:cookies?|credentials?|secrets?)\.(?:json|ya?ml|txt)$/i.test(normalized)) {
    findings.push('sensitive data file');
  }
  if (/(^|\/)\.(?:npmrc|pypirc)$/i.test(normalized)) findings.push('package registry credentials');

  return findings;
}

export function auditText(text) {
  const findings = [];
  for (const [label, pattern] of CONTENT_RULES) {
    if (pattern.test(text)) findings.push(label);
  }

  const emails = text.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi) || [];
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    if (!SAFE_EMAIL_DOMAINS.has(domain)) findings.push('personal email address');
  }

  return [...new Set(findings)];
}

export function auditRepository(repositoryRoot = REPOSITORY_ROOT) {
  const trackedOutput = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const trackedFiles = trackedOutput.split('\0').filter(Boolean);
  const findings = [];

  for (const relativePath of trackedFiles) {
    for (const kind of auditRelativePath(relativePath)) findings.push({ file: relativePath, kind });

    const bytes = readFileSync(path.join(repositoryRoot, relativePath));
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const kind of auditText(text)) findings.push({ file: relativePath, kind });
  }

  return { findings, scannedFiles: trackedFiles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const result = auditRepository();
  if (result.findings.length) {
    console.error(`Public safety audit failed with ${result.findings.length} finding(s):`);
    for (const finding of result.findings) console.error(`- ${finding.file}: ${finding.kind}`);
    process.exitCode = 1;
  } else {
    console.log(`Public safety audit passed (${result.scannedFiles} tracked files scanned).`);
  }
}
