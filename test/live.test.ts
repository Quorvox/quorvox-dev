import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveProxy, lanAddress, isPrivateAddr } from '../src/live.ts';
import { Stack } from '../src/stack.ts';
import { detectServices } from '../src/detect.ts';

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

// подписка на SSE прокси, копим всё, что пришло
function sse(port: number) {
  const got: string[] = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/__quorvox_reload' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => got.push(c));
  });
  return { got, close: () => req.destroy() };
}

function fakeTarget(port: number) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>привет</h1></body></html>');
    } else if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('console.log(1)');
    } else {
      res.writeHead(404).end();
    }
  });
  // «веб-сокет»: отвечаем 101 и эхо-ем всё, что пришло
  srv.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
  });
  return new Promise<http.Server>((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

test('прокси: вставляет скрипт в HTML, остальное отдаёт как есть', async () => {
  const target = await fakeTarget(45901);
  const proxy = new LiveProxy(45901);
  const port = await proxy.listen();

  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(html.includes('<h1>привет</h1>'));
  assert.ok(html.includes('/__quorvox_reload.js'));
  assert.ok(html.indexOf('/__quorvox_reload.js') < html.indexOf('</body>'));

  const js = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
  assert.equal(js, 'console.log(1)');

  const client = await (await fetch(`http://127.0.0.1:${port}/__quorvox_reload.js`)).text();
  assert.ok(client.includes('EventSource'));

  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);

  proxy.close();
  target.close();
  target.closeAllConnections();
});

test('прокси: reload() доходит до подписанной вкладки', async () => {
  const target = await fakeTarget(45902);
  const proxy = new LiveProxy(45902);
  const port = await proxy.listen();
  const s = sse(port);
  await waitFor(() => s.got.length > 0);

  proxy.reload();
  await waitFor(() => s.got.join('').includes('data: reload'));

  s.close();
  proxy.close();
  target.close();
  target.closeAllConnections();
});

test('прокси: WebSocket-подобный upgrade пробрасывается', async () => {
  const target = await fakeTarget(45903);
  const proxy = new LiveProxy(45903);
  const port = await proxy.listen();

  const got: string[] = [];
  const sock = net.connect(port, '127.0.0.1');
  sock.setEncoding('utf8');
  sock.on('data', (d: string) => got.push(d));
  sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await waitFor(() => got.join('').includes('101'));
  sock.write('ping');
  await waitFor(() => got.join('').includes('ping'));

  sock.destroy();
  proxy.close();
  target.close();
  target.closeAllConnections();
});

test('прокси: если сервис лежит — 502 со страницей, которая сама перезагрузится', async () => {
  const proxy = new LiveProxy(45904); // там никто не слушает
  const port = await proxy.listen();
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.ok(html.includes('location.reload'));
  proxy.close();
});

const post = (port: number, path: string, body: string, ua = 'Mozilla/5.0 (Windows NT 10.0)') =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'user-agent': ua, 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });

test('браузерные логи: ошибки доходят событием, телефон отличается по UA, повторы и мусор отсекаются', async () => {
  const target = await fakeTarget(45905);
  const proxy = new LiveProxy(45905);
  const port = await proxy.listen();
  const got: { level: string; text: string; page: string; device: string }[] = [];
  proxy.on('browserlog', (b) => got.push(b));
  try {
    assert.equal(await post(port, '/__quorvox_log', JSON.stringify({ level: 'error', text: 'boom is not defined (app.js:12)', page: '/clubs' })), 204);
    await post(port, '/__quorvox_log', JSON.stringify({ level: 'warn', text: 'GET /api/x → 404', page: '/' }), 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148');
    await post(port, '/__quorvox_log', JSON.stringify({ level: 'error', text: 'boom is not defined (app.js:12)', page: '/clubs' })); // повтор
    await post(port, '/__quorvox_log', 'это не json');
    await post(port, '/__quorvox_log', JSON.stringify({ level: 'error', text: '' })); // пустое
    await sleep(100);

    assert.equal(got.length, 2);
    assert.deepEqual([got[0].level, got[0].device, got[0].page], ['error', 'browser', '/clubs']);
    assert.deepEqual([got[1].level, got[1].device], ['warn', 'phone']);

    // клиентский скрипт действительно ловит ошибки и запросы
    const client = await (await fetch(`http://127.0.0.1:${port}/__quorvox_reload.js`)).text();
    for (const piece of ['sendBeacon', 'unhandledrejection', 'console[lvl]', 'window.fetch']) assert.ok(client.includes(piece), piece);
    new Function(client); // скрипт синтаксически корректен
  } finally {
    proxy.close();
    target.close();
    target.closeAllConnections();
  }
});

test('телефон: доступ из сети включается явно, работает по адресу сети и выключается; чужие адреса запрещены', async () => {
  assert.equal(isPrivateAddr('192.168.1.5'), true);
  assert.equal(isPrivateAddr('::ffff:10.0.0.2'), true);
  assert.equal(isPrivateAddr('172.16.4.1'), true);
  assert.equal(isPrivateAddr('127.0.0.1'), true);
  assert.equal(isPrivateAddr('172.32.0.1'), false);
  assert.equal(isPrivateAddr('8.8.8.8'), false);
  assert.equal(isPrivateAddr('::ffff:93.184.216.34'), false);
  assert.equal(isPrivateAddr(undefined), false);

  const target = await fakeTarget(45906);
  const proxy = new LiveProxy(45906);
  await proxy.listen();
  try {
    assert.equal(proxy.lanUrl(), null, 'по умолчанию доступа из сети нет');

    const url = await proxy.exposeLan();
    if (lanAddress()) {
      assert.ok(url && /^http:\/\/(192\.168|10\.|172\.)/.test(url), `адрес: ${url}`);
      const html = await (await fetch(url!)).text();
      assert.ok(html.includes('/__quorvox_reload.js'), 'через адрес сети отдаётся тот же сайт с живым обновлением');
      proxy.hideLan();
      assert.equal(proxy.lanUrl(), null);
      await assert.rejects(fetch(url!, { signal: AbortSignal.timeout(2000) }), 'после выключения адрес недоступен');
    } else {
      assert.equal(url, null, 'нет сети — честно говорим, что адреса нет');
    }
  } finally {
    proxy.close();
    target.close();
    target.closeAllConnections();
  }
});

test('стек: html → только обновление браузера, серверный файл → рестарт и обновление', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  const server = (v: string) =>
    `require('http').createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<body>${v}</body>'); })` +
    `.listen(45881, '127.0.0.1', () => console.log('listening on http://localhost:45881'));`;
  writeFileSync(join(dir, 'server.js'), server('v1'));
  writeFileSync(join(dir, 'public', 'index.html'), '<body>x</body>');

  const stack = new Stack(detectServices(dir));
  const logs: string[] = [];
  let url = '';
  stack.on('log', (n: string, l: string) => logs.push(l));
  stack.on('proxy', (n: string, u: string) => (url = u));
  stack.startAll();
  await waitFor(() => url !== '');
  assert.equal(url, 'http://localhost:55881');

  assert.ok((await (await fetch(url)).text()).includes('v1'));
  const port = Number(url.split(':').pop());

  // ошибка из браузера попадает в общие логи сервиса
  await post(port, '/__quorvox_log', JSON.stringify({ level: 'error', text: 'ReferenceError: x is not defined', page: '/shop' }));
  await waitFor(() => logs.some((l) => l.includes('🌐 [браузер] error: ReferenceError: x is not defined — /shop')));
  const s = sse(port);
  await waitFor(() => s.got.length > 0);

  // правка html: сервер НЕ перезапускается, вкладка обновляется
  const before = logs.filter((l) => l.startsWith('перезапуск')).length;
  assert.equal(stack.fileSaved(join(dir, 'public', 'index.html')).length, 1);
  await waitFor(() => s.got.join('').includes('data: reload'));
  assert.equal(logs.filter((l) => l.startsWith('перезапуск')).length, before);

  // правка серверного файла: рестарт, потом ещё одно обновление
  s.got.length = 0;
  writeFileSync(join(dir, 'server.js'), server('v2'));
  assert.equal(stack.fileSaved(join(dir, 'server.js')).length, 1);
  await waitFor(() => s.got.join('').includes('data: reload'), 12000);
  assert.ok((await (await fetch(url)).text()).includes('v2'));

  s.close();
  await stack.stopAll();
  rmSync(dir, RM);
});
