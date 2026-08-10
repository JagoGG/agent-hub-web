import assert from 'node:assert/strict';
import test from 'node:test';

import { auditRelativePath, auditText } from '../scripts/public-safety.mjs';

test('la auditoria bloquea secretos y datos personales', () => {
  const token = 'ghp_' + 'A'.repeat(36);
  const localPath = ['C:', 'Users', 'private-user', 'document.txt'].join('\\');
  const personalEmail = ['private-owner', 'gmail.com'].join('@');
  const findings = auditText([token, localPath, personalEmail].join('\n'));

  assert.ok(findings.includes('GitHub access token'));
  assert.ok(findings.includes('local user profile path'));
  assert.ok(findings.includes('personal email address'));
});

test('la auditoria bloquea archivos que no pertenecen a un repo publico', () => {
  assert.deepEqual(auditRelativePath('.env.production'), ['environment file']);
  assert.deepEqual(auditRelativePath('storage/users.json'), ['runtime JSON data']);
  assert.deepEqual(auditRelativePath('certificates/release.p12'), ['credential container']);
});

test('la auditoria permite ejemplos publicos y contenido normal', () => {
  assert.deepEqual(auditRelativePath('.env.example'), []);
  assert.deepEqual(auditText('Contact: security@example.com\nPath: ./assets/app.js'), []);
});
