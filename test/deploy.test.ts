import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDeployConfig,
  planFiles,
  findSecrets,
  makeArchive,
  deployRelease,
  rollbackRelease,
  buildDeployScript,
  buildConfirmScript,
  buildRollbackScript,
  confirmRelease,
  describePlan,
  realRun,
  q,
} from '../src/deploy.ts';
import type { Run, DeployConfig } from '../src/deploy.ts';

function write(dir: string, rel: string, text = 'x') {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'qv-dep-'));
  write(dir, 'package.json', '{}');
  write(dir, 'src/app.js', 'console.log(1)');
  write(dir, 'public/index.html', '<p>x</p>');
  write(dir, '.env.example', 'PORT=');
  // это уезжать не должно
  write(dir, '.env', 'TOKEN=secret');
  write(dir, '.env.local', 'A=1');
  write(dir, 'node_modules/a/index.js');
  write(dir, 'data/app.db');
  write(dir, 'data/x.json');
  write(dir, 'app.sqlite-wal');
  write(dir, 'logs/a.log');
  write(dir, 'notes.log');
  write(dir, 'cert.pem');
  write(dir, '.git/config');
  write(dir, '.claude/x.md');
  write(dir, 'uploads/u.png');
  write(dir, 'private/secret.txt');
  write(dir, 'old.bak');
  write(dir, 'quorvox.json', '{"deploy":{}}');
  return dir;
}

const CFG: DeployConfig = { host: '203.0.113.7', user: 'root', path: '/opt/app', restart: 'pm2 restart app', install: 'npm ci --omit=dev', check: 'curl -fsS -o /dev/null http://127.0.0.1:3410/' };

test('деплой: конфиг проверяется, опасные значения не проходят', () => {
  const ok = parseDeployConfig({ deploy: { host: '203.0.113.7', user: 'root', path: '/opt/app/', restart: 'pm2 restart app', port: 2222 } });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config!.path, '/opt/app', 'хвостовой слэш убран');
  assert.equal(ok.config!.port, 2222);

  assert.equal(parseDeployConfig({}).config, null);
  assert.deepEqual(parseDeployConfig({}).problems, []);

  const evil = parseDeployConfig({ deploy: { host: '-oProxyCommand=calc', user: 'root', path: '/opt/app' } });
  assert.equal(evil.config, null);
  assert.ok(evil.problems.some((p) => p.includes('host')));

  for (const path of ['/', 'opt/app', '/opt/../etc', '']) {
    assert.equal(parseDeployConfig({ deploy: { host: 'h.example.com', user: 'u', path } }).config, null, path);
  }
  assert.equal(parseDeployConfig({ deploy: { host: 'h.example.com', user: 'u -x', path: '/opt/app' } }).config, null);
  assert.equal(parseDeployConfig({ deploy: { host: 'h.example.com', user: 'u', path: '/opt/app', port: 99999 } }).config, null);
});

test('деплой: что отправляем — код да, секреты, базы, ключи, зависимости и данные нет', () => {
  const dir = project();
  try {
    const plan = planFiles(dir, { exclude: ['private', '*.bak'] });
    assert.deepEqual(plan.files, ['.env.example', 'package.json', 'public/index.html', 'src/app.js']);
    const why = Object.fromEntries(plan.skipped.map((s) => [s.what, s.why]));
    assert.ok(why['.env'].includes('секреты'));
    assert.ok(why['.env.local'].includes('секреты'));
    assert.ok(why['node_modules/'].includes('зависимости'));
    assert.ok(why['data/'].includes('баз'));
    assert.ok(why['cert.pem'].includes('ключи'));
    assert.ok(why['app.sqlite-wal'].includes('баз'));
    assert.ok(why['.git/'] && why['.claude/']);
    assert.ok(why['quorvox.json'].includes('настройки расширения'));
    assert.equal(why['private'], 'исключено в quorvox.json');
    assert.equal(why['old.bak'], 'исключено в quorvox.json');
    assert.equal(plan.tooBig, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('деплой: в файлах на отправку ищем явные секреты', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-dep-'));
  try {
    write(dir, 'bot.js', `const t = '123456789:${'A'.repeat(35)}';`);
    write(dir, 'deploy.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc');
    write(dir, 'clean.js', 'const x = 1;');
    const found = findSecrets(dir, ['bot.js', 'deploy.txt', 'clean.js']);
    assert.deepEqual(found.map((f) => [f.file, f.kind]).sort(), [['bot.js', 'токен Telegram-бота'], ['deploy.txt', 'приватный ключ']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('деплой: настоящий tar собирает архив ровно из списка (без .env, баз и ключей)', async (t) => {
  const dir = project();
  try {
    const plan = planFiles(dir, { exclude: ['private', '*.bak'] });
    let tmp;
    try {
      tmp = await makeArchive(dir, plan.files, realRun);
    } catch (e) {
      t.skip('tar недоступен: ' + (e as Error).message);
      return;
    }
    const list = await realRun('tar', ['-tzf', tmp.file]);
    const inArchive = list.out.split(/\r?\n/).map((l) => l.replace(/^\.\//, '').trim()).filter((l) => l && !l.endsWith('/'));
    assert.deepEqual(inArchive.sort(), plan.files);
    for (const bad of ['.env', 'data/app.db', 'cert.pem', 'node_modules/a/index.js']) assert.ok(!inArchive.includes(bad), bad);
    rmSync(tmp.dir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// подставной «сервер»: записывает вызовы и отвечает как скажем
function fakeRun(sshReply: { code: number; out: string }, scpCode = 0) {
  const calls: { cmd: string; args: string[]; cwd?: string; input?: string }[] = [];
  const run: Run = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd, input: opts?.input });
    if (cmd === 'ssh') return sshReply;
    if (cmd === 'scp') return { code: scpCode, out: scpCode ? 'scp: ошибка' : '' };
    return { code: 0, out: '' }; // tar
  };
  return { run, calls };
}

const OK_OUT = 'QV_STEP backup\nQV_STEP unpack\nQV_STEP install\nQV_STEP restart\nQV_STEP check\nQV_OK\n';
const NOW = () => new Date(2026, 10, 12, 10, 10, 10);

test('деплой: порядок действий, безопасные аргументы ssh/scp, копия старого кода до распаковки', async () => {
  const dir = project();
  const { run, calls } = fakeRun({ code: 0, out: OK_OUT });
  const logs: string[] = [];
  try {
    const plan = planFiles(dir);
    const res = await deployRelease(dir, { ...CFG, port: 2222 }, plan.files, { run, log: (l) => logs.push(l), now: NOW });
    assert.equal(res.ok, true);
    assert.equal(res.backup, '20261112-101010');
    assert.deepEqual(calls.map((c) => c.cmd), ['tar', 'scp', 'ssh']);

    const tar = calls[0].args;
    assert.ok(tar.includes('-T') && tar.includes('-czf'));

    const scp = calls[1];
    assert.ok(scp.args.includes('BatchMode=yes'), 'никаких запросов пароля');
    assert.deepEqual(scp.args.slice(scp.args.indexOf('-P'), scp.args.indexOf('-P') + 2), ['-P', '2222']);
    assert.ok(scp.args.includes('release.tgz'), 'короткое имя файла: «A:\\…» scp принял бы за адрес');
    assert.equal(scp.args[scp.args.length - 1], 'root@203.0.113.7:/tmp/quorvox-20261112-101010.tgz');
    assert.ok(scp.cwd && !existsSync(scp.cwd), 'временная папка с архивом убрана');

    const ssh = calls[2];
    assert.ok(ssh.args.includes('BatchMode=yes'));
    assert.deepEqual(ssh.args.slice(ssh.args.indexOf('-p'), ssh.args.indexOf('-p') + 2), ['-p', '2222']);
    assert.equal(ssh.args[ssh.args.length - 2], 'root@203.0.113.7');
    assert.equal(ssh.args[ssh.args.length - 1], 'sh -s');
    const script = ssh.input!;
    assert.ok(script.startsWith('set -e'));
    assert.ok(script.indexOf('tar -czf "$B/20261112-101010.tgz"') < script.indexOf('-xzf "$A"'), 'сначала копия старого, потом распаковка нового');
    assert.ok(script.includes('umask 022') && script.includes('--no-same-permissions'), 'права берутся по umask сервера, а не из архива');
    assert.ok(script.includes('--exclude=./data') && script.includes("--exclude='./.env*'"), 'копия не трогает данные и секреты');
    assert.ok(script.indexOf('npm ci --omit=dev') < script.indexOf('pm2 restart app'));
    assert.ok(script.indexOf('pm2 restart app') < script.indexOf('curl -fsS'));
    assert.ok(!script.includes('rm -rf'), 'ничего на сервере не удаляем');
    assert.ok(logs.some((l) => l.includes('Собираю архив')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('деплой: путь с кавычкой и пробелом безопасно экранируется', () => {
  assert.equal(q("/opt/it's app"), `'/opt/it'\\''s app'`);
  const script = buildDeployScript({ ...CFG, path: "/opt/it's app" }, '/tmp/a.tgz', '20260101-000000');
  assert.ok(script.includes(`P='/opt/it'\\''s app'`));
});

test('деплой: ошибки понятно объясняются, а после сбоя на сервере предлагается откат', async () => {
  const dir = project();
  try {
    const plan = planFiles(dir);
    const hooks = (run: Run) => ({ run, log: () => {}, now: NOW });

    // ssh не подключился
    let r = await deployRelease(dir, CFG, plan.files, hooks(fakeRun({ code: 255, out: 'Permission denied' }).run));
    assert.equal(r.ok, false);
    assert.equal(r.step, 'server');
    assert.ok(r.message.includes('по ключу'));

    // scp не подключился
    r = await deployRelease(dir, CFG, plan.files, hooks(fakeRun({ code: 0, out: OK_OUT }, 255).run));
    assert.equal(r.step, 'upload');
    assert.ok(r.message.includes('по ключу'));

    // упал перезапуск: код уже разложен, копия старого сохранена → можно откатить
    r = await deployRelease(dir, CFG, plan.files, hooks(fakeRun({ code: 1, out: 'QV_STEP backup\nQV_STEP unpack\nQV_STEP install\nQV_STEP restart\npm2: not found\n' }).run));
    assert.equal(r.ok, false);
    assert.equal(r.failedAt, 'restart');
    assert.equal(r.backup, '20261112-101010');
    assert.ok(r.message.includes('перезапуск'));

    // папки на сервере нет (первая выкладка): ничего не менялось, предлагаем создать, архив в /tmp подчищаем
    const noDir = fakeRun({ code: 3, out: 'QV_FAIL no-dir\n' });
    r = await deployRelease(dir, CFG, plan.files, hooks(noDir.run));
    assert.equal(r.ok, false);
    assert.equal(r.noDir, true);
    assert.equal(r.failedAt, undefined);
    assert.equal(r.backup, undefined);
    assert.ok(r.message.includes('нет папки /opt/app'));
    const cleanup = noDir.calls[noDir.calls.length - 1];
    assert.equal(cleanup.cmd, 'ssh');
    assert.ok(cleanup.args[cleanup.args.length - 1].startsWith("rm -f '/tmp/quorvox-"), 'временный архив на сервере убран');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('деплой: откат возвращает последнюю копию, перезапускает и проверяет', async () => {
  const { run, calls } = fakeRun({ code: 0, out: 'QV_STEP rollback x\nQV_STEP restart\nQV_STEP check\nQV_OK\n' });
  const res = await rollbackRelease(CFG, { run, log: () => {} });
  assert.equal(res.ok, true);
  const script = calls[0].input!;
  assert.ok(script.includes('ls -1t "$B"/*.tgz'));
  assert.ok(script.indexOf('-xzf "$LAST"') < script.indexOf('pm2 restart app'));
  assert.ok(script.includes('--no-same-permissions'));
  assert.ok(!script.includes('rm -rf'));

  const bad = await rollbackRelease(CFG, { run: fakeRun({ code: 4, out: 'QV_FAIL на сервере нет сохранённых копий\n' }).run, log: () => {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.message.includes('нет сохранённых копий'));
});

test('деплой: первая выкладка создаёт папку, не пытается копировать пустое, и без create папку не создаёт', () => {
  const first = buildDeployScript(CFG, '/tmp/a.tgz', '20260101-000000', true);
  assert.ok(first.includes('mkdir -p "$P"'));
  assert.ok(first.indexOf('mkdir -p "$P"') < first.indexOf('[ -d "$P" ]'));
  assert.ok(first.includes('первая выкладка: копировать нечего'));
  const normal = buildDeployScript(CFG, '/tmp/a.tgz', '20260101-000000');
  assert.ok(!normal.includes('mkdir -p "$P"'), 'без явной просьбы папку на сервере не создаём');
  assert.ok(normal.includes('QV_FAIL no-dir'));
});

test('деплой: «работает» удаляет только копию этой выкладки; откат — именно на неё', async () => {
  const ts = '20261112-110810';
  const script = buildConfirmScript(CFG, ts);
  assert.ok(script.includes(`F="$B/${ts}.tgz"`));
  assert.ok(script.includes('rm -f -- "$F"'));
  assert.equal((script.match(/\brm\b/g) ?? []).length, 1, 'удаление ровно одно');
  assert.ok(!script.includes('rm -rf') && !script.includes('*'), 'никаких масок и рекурсии');

  // путь подсунуть нельзя
  for (const bad of ['../../etc/passwd', '20261112-11081', '20261112-110810; rm -rf /', '', '*']) {
    assert.throws(() => buildConfirmScript(CFG, bad), /некорректное имя копии/, bad);
    assert.throws(() => buildRollbackScript(CFG, bad), /некорректное имя копии/, bad);
  }

  const { run, calls } = fakeRun({ code: 0, out: 'QV_STEP removed\nQV_OK\n' });
  const res = await confirmRelease(CFG, ts, { run, log: () => {} });
  assert.equal(res.ok, true);
  assert.equal(calls[0].cmd, 'ssh');
  assert.ok(calls[0].input!.includes(ts));

  // откат на конкретную копию
  const rb = buildRollbackScript(CFG, ts);
  assert.ok(rb.includes(`LAST="$B/${ts}.tgz"`));
  assert.ok(!rb.includes('ls -1t'), 'не угадываем «самую свежую»: берём ту, что выбрали');
  assert.ok(buildRollbackScript(CFG).includes('ls -1t'), 'без указания — самая свежая, как раньше');

  const bad = await confirmRelease(CFG, ts, { run: fakeRun({ code: 255, out: '' }).run, log: () => {} });
  assert.equal(bad.ok, false);
});

test('деплой: оборванное до начала соединение повторяется, оборванное посреди работы — нет', async () => {
  const noWait = async () => {};
  // сервер сначала обрывает, потом отвечает
  let n = 0;
  const flaky: Run = async (cmd) => {
    if (cmd !== 'ssh') return { code: 0, out: '' };
    return ++n === 1 ? { code: 255, out: 'Connection closed by 203.0.113.7 port 22' } : { code: 0, out: 'QV_STEP removed\nQV_OK\n' };
  };
  const logs: string[] = [];
  const ok = await confirmRelease(CFG, '20261112-110810', { run: flaky, log: (l) => logs.push(l), sleep: noWait });
  assert.equal(ok.ok, true);
  assert.equal(n, 2, 'одна повторная попытка');
  assert.ok(logs.some((l) => l.includes('пробую ещё раз')));

  // всё время обрывает: после двух повторов честно сдаёмся и объясняем про ключ
  let calls = 0;
  const dead: Run = async () => (calls++, { code: 255, out: 'Connection closed' });
  const bad = await confirmRelease(CFG, '20261112-110810', { run: dead, log: () => {}, sleep: noWait });
  assert.equal(bad.ok, false);
  assert.equal(calls, 3, 'первая попытка и два повтора');

  // оборвалось после начала скрипта (есть QV_STEP): повторять нельзя, иначе шаги выполнятся дважды
  let mid = 0;
  const cut: Run = async () => (mid++, { code: 255, out: 'QV_STEP backup\nQV_STEP unpack\n' });
  const dir = project();
  try {
    const plan = planFiles(dir);
    const r = await deployRelease(dir, CFG, plan.files, { run: async (c, a, o) => (c === 'ssh' ? cut(c, a, o) : { code: 0, out: '' }), log: () => {}, now: NOW, sleep: noWait });
    assert.equal(r.ok, false);
    assert.equal(mid, 1, 'без повторов после начала работы на сервере');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('деплой: первая выкладка не создаёт копии, поэтому откатывать/подтверждать нечего', async () => {
  const dir = project();
  try {
    const plan = planFiles(dir);
    const first = await deployRelease(
      dir,
      CFG,
      plan.files,
      { run: fakeRun({ code: 0, out: 'QV_STEP backup\nпервая выкладка: копировать нечего\nQV_STEP unpack\nQV_OK\n' }).run, log: () => {}, now: NOW },
      { create: true },
    );
    assert.equal(first.ok, true);
    assert.equal(first.hasBackup, false);
    assert.equal(first.backup, undefined);
    const second = await deployRelease(dir, CFG, plan.files, { run: fakeRun({ code: 0, out: OK_OUT }).run, log: () => {}, now: NOW });
    assert.equal(second.hasBackup, true);
    assert.equal(second.backup, '20261112-101010');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('деплой: описание плана для окна подтверждения', () => {
  const lines = describePlan({ ...CFG, port: 2222 }, { files: ['a', 'b'], bytes: 2 * 1024 * 1024, skipped: [], warnings: [] });
  assert.ok(lines[0].includes('root@203.0.113.7:/opt/app') && lines[0].includes('2222'));
  assert.ok(lines[1].includes('2 файлов') && lines[1].includes('2.0 МБ'));
  assert.ok(lines.some((l) => l.includes('копия текущего кода')));
  assert.ok(lines.some((l) => l.includes('pm2 restart app')));
});
