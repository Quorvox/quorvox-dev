import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { detectServices } from '../src/detect.ts';
import { Stack } from '../src/stack.ts';

// Windows ещё миг держит папку убитого процесса: удаляем с повторами, иначе EPERM
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 150 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error('не дождались условия');
}

// занят ли порт — так проверяем, что процесс реально жив или убит
const portBusy = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });

function fakeProject(port: number, version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fake', scripts: { start: 'node server.js' } }),
  );
  writeServer(dir, port, version);
  return dir;
}

function writeServer(dir: string, port: number, version: string) {
  writeFileSync(
    join(dir, 'server.js'),
    `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up ${version}'));`,
  );
}

test('detect: берёт start, dev с --watch помечает selfWatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  mkdirSync(join(dir, 'api'));
  mkdirSync(join(dir, 'web'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'api', 'package.json'), JSON.stringify({ scripts: { start: 'node a.js' } }));
  writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'x' } }));
  const svc = detectServices(dir);
  assert.deepEqual(svc.map((s) => [s.name, s.command, s.selfWatch]), [
    ['api', 'npm run start', false],
    ['web', 'npm run dev', true],
  ]);
  rmSync(dir, RM);
});

test('detect: quorvox.json главнее автопоиска', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  writeFileSync(
    join(dir, 'quorvox.json'),
    JSON.stringify({ services: [{ name: 'bot', cwd: 'b', command: 'python bot.py' }] }),
  );
  const [s] = detectServices(dir);
  assert.equal(s.name, 'bot');
  assert.equal(s.command, 'python bot.py');
  assert.ok(s.cwd.endsWith('b'));
  rmSync(dir, RM);
});

test('запуск, логи, рестарт по сохранению, остановка убивает дерево процессов', async () => {
  const port = 45871;
  const dir = fakeProject(port, 'v1');
  const stack = new Stack(detectServices(dir));
  const logs: string[] = [];
  stack.on('log', (n: string, l: string) => logs.push(l));

  stack.startAll();
  await waitFor(() => logs.includes('up v1'));
  assert.equal(await portBusy(port), true, 'порт должен быть занят после старта');

  // правим файл и «сохраняем» — сервис должен подняться уже с v2
  writeServer(dir, port, 'v2');
  const hit = stack.fileSaved(join(dir, 'server.js'));
  assert.equal(hit.length, 1);
  await waitFor(() => logs.includes('up v2'));

  // сохранение в node_modules и картинки не должны рестартить
  assert.equal(stack.fileSaved(join(dir, 'node_modules', 'x.js')).length, 0);
  assert.equal(stack.fileSaved(join(dir, 'logo.png')).length, 0);

  await stack.stopAll();
  await waitFor(async () => !(await portBusy(port)));
  assert.equal(stack.anyRunning(), false);
  rmSync(dir, RM);
});

test('игнор: data/, скрытые папки; .env срабатывает; цикл рестартов гасится', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  // node напрямую, без npm: быстрый рестарт, чтобы тест не зависел от нагрузки на машину
  writeFileSync(join(dir, 'quorvox.json'), JSON.stringify({ services: [{ name: 's', command: 'node s.js' }] }));
  writeFileSync(join(dir, 's.js'), 'setInterval(() => {}, 1000)');
  const stack = new Stack(detectServices(dir));
  const logs: string[] = [];
  stack.on('log', (n: string, l: string) => logs.push(l));
  stack.startAll();
  await waitFor(() => stack.anyRunning());

  assert.equal(stack.fileSaved(join(dir, 'data', 'cache.json')).length, 0, 'data/ игнорим');
  assert.equal(stack.fileSaved(join(dir, '.test-data-x', 'a.json')).length, 0, 'скрытые папки игнорим');
  assert.equal(stack.fileSaved(join(dir, '.env')).length, 1, '.env должен срабатывать');

  try {
    // сыпем сохранениями, пока не сработает защита; больше 5 рестартов за окно быть не должно
    for (let i = 0; i < 40 && !logs.some((l) => l.includes('слишком частые')); i++) {
      stack.fileSaved(join(dir, 's.js'));
      await sleep(400);
    }
    assert.ok(logs.some((l) => l.includes('слишком частые')), 'цикл должен погаситься');
    assert.ok(logs.filter((l) => l.startsWith('перезапуск')).length <= 5);
  } finally {
    await stack.stopAll();
    rmSync(dir, RM);
  }
});

test('сохранение во время рестарта не теряется: сервис поднимается с последней версией', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node s.js' } }));
  const prog = (v: string) => `console.log('ver ${v}'); setInterval(() => {}, 1000)`;
  writeFileSync(join(dir, 's.js'), prog('1'));
  const stack = new Stack(detectServices(dir));
  const logs: string[] = [];
  stack.on('log', (n: string, l: string) => logs.push(l));
  stack.startAll();
  try {
    await waitFor(() => logs.includes('ver 1'));

    writeFileSync(join(dir, 's.js'), prog('2'));
    stack.fileSaved(join(dir, 's.js'));
    await sleep(450); // рестарт уже пошёл (дебаунс 300мс), сервис в процессе остановки
    writeFileSync(join(dir, 's.js'), prog('3'));
    stack.fileSaved(join(dir, 's.js'));

    await waitFor(() => logs.includes('ver 3'), 15000);
    assert.equal(stack.anyRunning(), true);
  } finally {
    await stack.stopAll();
    rmSync(dir, RM);
  }
});

test('стоп во время рестарта не оставляет призрачный процесс', async () => {
  const port = 45872;
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  writeFileSync(join(dir, 'quorvox.json'), JSON.stringify({ services: [{ name: 's', command: 'node s.js' }] }));
  writeFileSync(join(dir, 's.js'), `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up'))`);
  const stack = new Stack(detectServices(dir));
  const logs: string[] = [];
  stack.on('log', (n: string, l: string) => logs.push(l));
  stack.startAll();
  try {
    await waitFor(() => logs.includes('up'));
    const r = stack.runners[0];
    const restarting = r.restart(); // убили старый, собираемся поднять новый
    await r.stop(); // а пользователь в этот момент нажал «Стоп»
    await restarting;
    await sleep(800);
    assert.equal(await portBusy(port), false, 'после стопа порт должен быть свободен');
    assert.equal(r.status, 'stopped');
  } finally {
    await stack.stopAll();
    rmSync(dir, RM);
  }
});

test('упавший сервис помечается crashed, а сохранение его поднимает', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node s.js' } }));
  writeFileSync(join(dir, 's.js'), 'process.exit(3)');
  const stack = new Stack(detectServices(dir));
  const logs: string[] = [];
  stack.on('log', (n: string, l: string) => logs.push(l));

  stack.startAll();
  await waitFor(() => stack.anyCrashed());

  writeFileSync(join(dir, 's.js'), 'console.log("ожил"); setInterval(() => {}, 1000)');
  stack.fileSaved(join(dir, 's.js'));
  await waitFor(() => logs.includes('ожил'));
  assert.equal(stack.anyRunning(), true);

  await stack.stopAll();
  rmSync(dir, RM);
});
