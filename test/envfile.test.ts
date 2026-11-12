import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEnvExample } from '../src/envfile.ts';
import type { EnvUse } from '../src/checks.ts';

const usage = new Map<string, EnvUse>([
  ['SESSION_SECRET', { file: 'server/index.js', line: 12, required: true }],
  ['PORT', { file: 'server/index.js', line: 3, required: false }],
  ['SMTP_URL', { file: 'server/mailer.js', line: 5, required: true }],
]);

test('.env.example: новый файл — только имена и подсказки, без значений', () => {
  const r = renderEnvExample(usage);
  assert.equal(r.existing, false);
  assert.deepEqual(r.added, ['PORT', 'SESSION_SECRET', 'SMTP_URL']);
  assert.ok(r.text.includes('SESSION_SECRET=\n'));
  assert.ok(r.text.includes('# server/index.js:12 — нужна, запасного значения в коде нет'));
  assert.ok(r.text.includes('# server/index.js:3 — необязательная'));
  // ни одного значения после «=»
  assert.ok(!/^[A-Z_]+=.+$/m.test(r.text));
});

test('.env.example: существующий файл не перезаписывается, дописываются только недостающие', () => {
  const old = 'PORT=3410\n# SMTP_URL=smtp://x\n';
  const r = renderEnvExample(usage, old);
  assert.equal(r.existing, true);
  assert.deepEqual(r.added, ['SESSION_SECRET']);
  assert.ok(r.text.startsWith(old), 'старое содержимое осталось как есть');
  assert.ok(r.text.includes('SESSION_SECRET='));
  assert.equal((r.text.match(/^PORT=/gm) ?? []).length, 1);

  const same = renderEnvExample(usage, 'PORT=1\nSESSION_SECRET=\nSMTP_URL=\n');
  assert.deepEqual(same.added, []);
  assert.equal(same.text, 'PORT=1\nSESSION_SECRET=\nSMTP_URL=\n');
});
