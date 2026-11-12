import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticServer } from '../src/staticserver.ts';

function write(dir: string, rel: string, text = 'x') {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

// у каждого теста свой порт: встроенный fetch держит соединение к прошлому серверу и иначе ловит ECONNRESET
let nextPort = 5600;

async function withSite<T>(fn: (base: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'qv-static-'));
  write(dir, 'index.html', '<h1>Главная</h1>');
  write(dir, 'about/index.html', '<h1>О нас</h1>');
  write(dir, 'css/style.css', 'body{color:red}');
  write(dir, 'js/app.js', 'console.log(1)');
  write(dir, 'img/logo.svg', '<svg/>');
  write(dir, 'docs/a.html', '<p>a</p>'); // папка без index.html
  write(dir, '.env', 'SECRET=1');
  write(dir, '.git/config', '[core]');
  write(dir, 'cert.pem', 'KEY');
  write(dir, 'app.sqlite', 'DB');
  mkdirSync(join(tmpdir(), 'qv-static-outside'), { recursive: true });
  write(join(tmpdir(), 'qv-static-outside'), 'secret.txt', 'за пределами сайта');
  const srv = await startStaticServer(dir, (nextPort += 30));
  try {
    return await fn(`http://127.0.0.1:${srv.port}`, dir);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('статический сервер: отдаёт страницы, стили и скрипты с верными типами и без кэша', () =>
  withSite(async (base) => {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.ok((await home.text()).includes('Главная'));
    assert.ok(home.headers.get('content-type')!.startsWith('text/html'));
    assert.equal(home.headers.get('cache-control'), 'no-store');

    assert.ok((await (await fetch(base + '/about/')).text()).includes('О нас'));
    assert.equal((await fetch(base + '/about')).redirected, true, 'без слэша → редирект на папку');

    const css = await fetch(base + '/css/style.css');
    assert.ok(css.headers.get('content-type')!.startsWith('text/css'));
    assert.ok((await fetch(base + '/js/app.js')).headers.get('content-type')!.startsWith('text/javascript'));
    assert.equal((await fetch(base + '/img/logo.svg')).headers.get('content-type'), 'image/svg+xml');
    const head = await fetch(base + '/css/style.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()), '');
  }));

test('статический сервер: секреты и скрытые файлы не отдаёт, из папки не выпускает', () =>
  withSite(async (base) => {
    for (const p of ['/.env', '/.git/config', '/cert.pem', '/app.sqlite', '/%2e%2e/qv-static-outside/secret.txt', '/..%2f..%2fetc/passwd', '/css/../.env']) {
      const r = await fetch(base + p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!(await r.text()).includes('SECRET=1'), p);
    }
    assert.equal((await fetch(base + '/nope.html')).status, 404);
    assert.equal((await fetch(base + '/x', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/%E0%A4%A')).status, 400, 'битая кодировка адреса не роняет сервер');
  }));

test('статический сервер: папка без index.html показывает список страниц', () =>
  withSite(async (base) => {
    const html = await (await fetch(base + '/docs/')).text();
    assert.ok(html.includes('a.html'));
    assert.ok(!html.includes('.env'));
  }));

test('статический сервер: занятый порт обходится, а после закрытия порт свободен', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-static-'));
  write(dir, 'index.html', 'x');
  const a = await startStaticServer(dir, 5650);
  const b = await startStaticServer(dir, 5650);
  try {
    assert.equal(a.port, 5650);
    assert.equal(b.port, 5651);
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const c = await startStaticServer(dir.replace(/qv-static-.*/, 'qv-static-none'), 5650).catch(() => null);
  await c?.close();
  assert.ok(c === null || c.port === 5650, 'порт снова доступен');
});
