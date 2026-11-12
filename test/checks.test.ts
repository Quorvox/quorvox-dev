import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeProject } from '../src/checks.ts';

function write(dir: string, rel: string, text: string) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

// мини-проект: express + роутеры с префиксами + фронт с api() и fetch()
function fakeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'qv-chk-'));
  write(dir, 'server/index.js', `
const express = require('express');
const app = express();
const clubs = require('./clubs');
const adminRouter = require('./admin');
app.get('/api/me', (q, r) => r.json({}));
app.post('/api/auth/login', (q, r) => r.json({}));
app.use('/api/clubs', clubs.router());
app.use('/api/admin', adminRouter({}));
const port = process.env.PORT || 3000;
const secret = process.env.SESSION_SECRET;
const feature = process.env.FEATURE_X ? 1 : 0;
app.listen(port);
`);
  write(dir, 'server/clubs.js', `
const express = require('express');
exports.router = () => {
  const r = express.Router();
  r.get('/', (q, s) => s.json([]));
  r.get('/:id', (q, s) => s.json({}));
  r.post('/:id/join', (q, s) => s.json({}));
  return r;
};
`);
  write(dir, 'server/admin.js', `
const express = require('express');
module.exports = () => {
  const r = express.Router();
  r.get('/stats', (q, s) => s.json({}));
  return r;
};
`);
  write(dir, 'public/js/util.js', `
export async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || 'GET' });
  return r.json();
}
`);
  write(dir, 'public/js/app.js', `
import { api } from './util.js';
api('/me');
api('/clubs');
api(\`/clubs/\${id}\`);
api('/clubs/' + id + '/join', { method: 'POST' });
api(\`/clubs/\${id}/join\`, { method: 'POST' });
api('/admin/stats');
api('/auth/login', { method: 'POST', body: {} });
fetch('/api/me');
// ниже — сломанное
api('/clubz');
api('/me/avatar');
api('/auth/login');
api(\`/clubs/\${id}/leave\`, { method: 'POST' });
api(\`/clubs/\${id}/join\`, { method: dynamicMethod });
`);
  return dir;
}

test('проверки: находят несуществующий маршрут и неверный метод, нормальное не трогают', () => {
  const dir = fakeProject();
  try {
    const rep = analyzeProject(dir);
    assert.equal(rep.stats.routes, 6, `маршрутов: ${rep.stats.routes}`);
    assert.deepEqual(rep.stats.unresolvedRouters, []);

    const msgs = rep.findings.filter((f) => f.kind === 'route' || f.kind === 'method').map((f) => f.message);
    assert.ok(msgs.some((m) => m.includes('/clubz')), 'опечатка /clubz');
    assert.ok(msgs.some((m) => m.includes('/me/avatar')), 'нет такого маршрута /me/avatar');
    assert.ok(msgs.some((m) => m.includes('GET /auth/login') || m.includes('GET /api/auth/login')), 'GET вместо POST на login');
    assert.ok(msgs.some((m) => m.includes('/clubs/:x/leave')), 'нет /clubs/:id/leave');
    // правильные вызовы и вызов с непонятным методом — без претензий
    assert.equal(msgs.length, 4, msgs.join('\n'));
    assert.ok(rep.findings.find((f) => f.message.includes('/clubz'))!.line! > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('проверки: переменные окружения — только «без запасного значения» и без описания', () => {
  const dir = fakeProject();
  try {
    // .env нет вообще → одно информационное замечание
    let env = analyzeProject(dir).findings.filter((f) => f.kind === 'env');
    assert.equal(env.length, 1);
    assert.equal(env[0].severity, 'info');

    // появился .env.example без SESSION_SECRET → предупреждение именно про неё
    write(dir, '.env.example', 'PORT=3000\n');
    env = analyzeProject(dir).findings.filter((f) => f.kind === 'env');
    assert.equal(env.length, 1);
    assert.ok(env[0].message.startsWith('SESSION_SECRET'));
    assert.equal(env[0].file, 'server/index.js');

    write(dir, '.env.example', 'PORT=3000\nSESSION_SECRET=x\n');
    assert.equal(analyzeProject(dir).findings.filter((f) => f.kind === 'env').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('проверки: текст несохранённого файла главнее диска, индекс для редактора заполнен', () => {
  const dir = fakeProject();
  try {
    write(dir, 'public/css/style.css', '.card { } .btn-main { }');
    write(dir, 'public/index.html', '<link rel="stylesheet" href="css/style.css"><div class="card"></div>');
    const base = analyzeProject(dir);
    // индекс: маршруты, префикс api, переменные, классы
    assert.equal(base.index.apiPrefix, '/api');
    assert.ok(base.index.routes.some((r) => r.method === 'POST' && r.full === '/api/clubs/:id/join' && r.file === 'server/clubs.js' && r.line > 0));
    assert.deepEqual(base.index.env.map((e) => e.name).sort(), ['FEATURE_X', 'PORT', 'SESSION_SECRET']);
    assert.equal(base.index.env.find((e) => e.name === 'SESSION_SECRET')!.required, true);
    assert.equal(base.index.env.find((e) => e.name === 'SESSION_SECRET')!.defined, false);
    assert.deepEqual(base.index.classes.map((c) => c.name).sort(), ['btn-main', 'card']);

    // человек набрал в app.js вызов api('/clubz2') и ещё не сохранил: на диске его нет
    const app = join(dir, 'public/js/app.js');
    const typed = `import { api } from './util.js';\napi('/clubs');\napi('/clubz2');\n`;
    const live = analyzeProject(dir, [], new Map([[app.toLowerCase(), typed]]));
    const msgs = live.findings.filter((f) => f.kind === 'route' || f.kind === 'method').map((f) => f.message);
    assert.deepEqual(msgs, ['Фронт зовёт /api/clubz2, а такого маршрута на сервере не нашёл'], 'видно только набранное, старые ошибки с диска ушли');
    assert.equal(live.findings.find((f) => f.message.includes('clubz2'))!.line, 3, 'строка берётся из набранного текста');

    // то же с CSS: набрали новый класс в несохранённом файле стилей
    const css = join(dir, 'public/css/style.css');
    const withNew = analyzeProject(dir, [], new Map([[css.toLowerCase(), '.card { } .btn-main { } .fresh-one { }']]));
    assert.ok(withNew.index.classes.some((c) => c.name === 'fresh-one'));
    assert.ok(!base.index.classes.some((c) => c.name === 'fresh-one'), 'диск при этом не менялся');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('проверки: два сервиса на одном порту', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-chk-'));
  try {
    write(dir, 'a/server.js', `require('http').createServer().listen(process.env.PORT || 4000)`);
    write(dir, 'b/server.js', `require('http').createServer().listen(process.env.PORT || 4000)`);
    const rep = analyzeProject(dir, [
      { name: 'a', cwd: join(dir, 'a') },
      { name: 'b', cwd: join(dir, 'b') },
    ]);
    const port = rep.findings.filter((f) => f.kind === 'port');
    assert.equal(port.length, 1);
    assert.equal(port[0].severity, 'error');
    assert.ok(port[0].message.includes('4000') && port[0].message.includes('a, b'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
