import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectServices } from '../src/detect.ts';
import { Stack } from '../src/stack.ts';
import { LiveProxy } from '../src/live.ts';

// Windows ещё миг держит папку убитого процесса: удаляем с повторами, иначе EPERM
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 150 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error('не дождались условия');
}

function write(dir: string, rel: string, text = 'x') {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

function sse(port: number) {
  const got: string[] = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/__quorvox_reload' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => got.push(c));
  });
  return { got, close: () => req.destroy() };
}

test('сайт без бэкенда: определяется сам (index.html, типичные папки, любые html), а проект с dev-скриптом — нет', () => {
  const only = mkdtempSync(join(tmpdir(), 'qv-fe-'));
  const nested = mkdtempSync(join(tmpdir(), 'qv-fe-'));
  const pages = mkdtempSync(join(tmpdir(), 'qv-fe-'));
  const empty = mkdtempSync(join(tmpdir(), 'qv-fe-'));
  const vite = mkdtempSync(join(tmpdir(), 'qv-fe-'));
  const cfg = mkdtempSync(join(tmpdir(), 'qv-fe-'));
  try {
    write(only, 'index.html');
    const [a] = detectServices(only);
    assert.equal(a.kind, 'static');
    assert.equal(a.cwd, only);
    assert.equal(a.selfWatch, true);

    write(nested, 'public/index.html');
    write(nested, 'package.json', JSON.stringify({ scripts: { build: 'x' } })); // есть package.json, но запускать нечего
    assert.equal(detectServices(nested)[0].cwd, join(nested, 'public'));

    write(pages, 'about.html');
    assert.equal(detectServices(pages)[0].kind, 'static');

    assert.deepEqual(detectServices(empty), [], 'пустая папка — сервисов нет');

    // папка с несколькими сайтами: каждый в своей подпапке
    const multi = mkdtempSync(join(tmpdir(), 'qv-fe-'));
    try {
      write(multi, 'blade/index.html');
      write(multi, 'kern/index.html');
      write(multi, 'fonts/fonts.css');
      write(multi, 'node_modules/x/index.html');
      const sites = detectServices(multi);
      assert.deepEqual(sites.map((s) => s.name).sort(), ['blade', 'kern']);
      assert.ok(sites.every((s) => s.kind === 'static'));
    } finally {
      rmSync(multi, RM);
    }

    write(vite, 'index.html');
    write(vite, 'package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
    const [v] = detectServices(vite);
    assert.equal(v.kind, undefined, 'dev-скрипт главнее статического режима');
    assert.equal(v.ownReload, true, 'у Vite своя перезагрузка');
    assert.equal(v.liveReload, true, 'но прокси (QR, логи браузера) подключается');

    write(cfg, 'quorvox.json', JSON.stringify({ services: [{ static: 'web' }] }));
    write(cfg, 'web/index.html');
    const [c] = detectServices(cfg);
    assert.equal(c.kind, 'static');
    assert.equal(c.cwd, join(cfg, 'web'));
    assert.equal(c.name, 'site');
  } finally {
    for (const d of [only, nested, pages, empty, vite, cfg]) rmSync(d, RM);
  }
});

test('сайт без бэкенда: запуск → адрес с автообновлением → правка CSS обновляет вкладку без рестарта → остановка', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-fe-'));
  write(dir, 'index.html', '<html><body><h1>Привет</h1></body></html>');
  write(dir, 'style.css', 'body{color:red}');
  write(dir, 'app.js', 'console.log(1)');
  write(dir, '.env', 'SECRET=1');
  const stack = new Stack(detectServices(dir));
  const logs: string[] = [];
  let url = '';
  stack.on('log', (n: string, l: string) => logs.push(l));
  stack.on('proxy', (n: string, u: string) => (url = u));
  try {
    assert.equal(stack.runners.length, 1);
    stack.startAll();
    await waitFor(() => url !== '');
    assert.ok(logs.some((l) => l.startsWith('Статический сайт: http://localhost:')));
    assert.equal(stack.anyRunning(), true);

    // страница отдаётся через прокси и получает скрипт живого обновления и ловли ошибок
    const html = await (await fetch(url)).text();
    assert.ok(html.includes('<h1>Привет</h1>'));
    assert.ok(html.includes('/__quorvox_reload.js'));
    assert.equal((await fetch(url + '/style.css')).status, 200);
    assert.notEqual((await fetch(url + '/.env')).status, 200, 'секреты не отдаются');

    const s = sse(Number(url.split(':').pop()));
    await waitFor(() => s.got.length > 0);
    for (const file of ['style.css', 'app.js', 'index.html']) {
      s.got.length = 0;
      const hit = stack.fileSaved(join(dir, file));
      assert.equal(hit.length, 1, file);
      await waitFor(() => s.got.join('').includes('data: reload'));
    }
    assert.equal(logs.filter((l) => l.startsWith('перезапуск')).length, 0, 'у статического сайта перезапусков нет, только обновление вкладки');

    s.close();
    await stack.stopAll();
    assert.equal(stack.anyRunning(), false);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1500) }), 'после остановки адрес закрыт');
  } finally {
    await stack.stopAll();
    rmSync(dir, RM);
  }
});

// «Vite»: пускает только localhost, редиректит на свой localhost-адрес
function fakeVite(port: number) {
  const srv = http.createServer((req, res) => {
    if (req.headers.host !== `localhost:${port}`) {
      res.writeHead(403).end('Blocked request. This host is not allowed.');
      return;
    }
    if (req.url === '/redir') {
      res.writeHead(302, { location: `http://localhost:${port}/final` }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>vite app</body></html>');
  });
  return new Promise<http.Server>((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

const get = (port: number, path: string, host: string) =>
  new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location as string | undefined, body }));
    });
    req.on('error', reject);
    req.end();
  });

test('Vite/Next: с адреса сети пускает (Host подменяется), редирект остаётся на адресе прокси, а перезагрузку не трогаем', async () => {
  const target = await fakeVite(45911);
  const plain = new LiveProxy(45911);
  const vite = new LiveProxy(45911);
  vite.rewriteHost = true;
  vite.reloadEnabled = false;
  const plainPort = await plain.listen();
  const vitePort = await vite.listen();
  try {
    // без подмены Host dev-сервер такого гостя не пускает
    assert.equal((await get(plainPort, '/', '192.168.1.5:13911')).status, 403);

    const ok = await get(vitePort, '/', '192.168.1.5:13911');
    assert.equal(ok.status, 200);
    assert.ok(ok.body.includes('vite app'));
    assert.ok(ok.body.includes('/__quorvox_reload.js'), 'ошибки браузера и QR работают и у Vite');

    const redir = await get(vitePort, '/redir', '192.168.1.5:13911');
    assert.equal(redir.status, 302);
    assert.equal(redir.location, 'http://192.168.1.5:13911/final', 'человек остаётся на адресе прокси, а не уходит на localhost');

    // перезагрузка выключена: ни reload(), ни reloadWhenUp() ничего не посылают
    const s = sse(vitePort);
    await waitFor(() => s.got.length > 0);
    s.got.length = 0;
    vite.reload();
    await vite.reloadWhenUp(10);
    await sleep(400);
    assert.ok(!s.got.join('').includes('data: reload'), 'у Vite свой HMR, мы не перезагружаем');
    s.close();
  } finally {
    plain.close();
    vite.close();
    target.close();
    target.closeAllConnections();
  }
});
