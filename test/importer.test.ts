import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRepoUrl, safeName, freeDir, inspectProject, installCommand, createEnvFromExample, extractZip, dropSymlinks, tarBin } from '../src/importer.ts';

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 150 } as const;
const tmp = () => mkdtempSync(join(tmpdir(), 'qv-imp-'));

test('ссылки: принимаем https на известные хостинги, остальное отбрасываем', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/Quorvox/quorvox-dev'), { url: 'https://github.com/Quorvox/quorvox-dev.git', name: 'quorvox-dev' });
  assert.deepEqual(parseRepoUrl(' https://github.com/a/b.git/ '), { url: 'https://github.com/a/b.git', name: 'b' });
  for (const bad of ['file:///etc/passwd', 'git@github.com:a/b.git', 'ssh://git@github.com/a/b', 'http://github.com/a/b', 'https://evil.example/a/b', '--upload-pack=calc', 'https://github.com/a/b --upload-pack=x', 'https://github.com/a', 'https://github.com/../b', '']) {
    assert.ok('error' in parseRepoUrl(bad), bad);
  }
});

test('имя папки очищается', () => {
  assert.equal(safeName('../../evil name!'), 'evil-name');
  assert.equal(safeName('...'), 'project');
  assert.equal(safeName('мой проект'), 'project');
});

test('свободное имя: если занято, добавляем номер', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'app'));
    assert.equal(freeDir(d, 'app'), join(d, 'app-2'));
    assert.equal(freeDir(d, 'new'), join(d, 'new'));
  } finally {
    rmSync(d, RM);
  }
});

test('осмотр Node-проекта: менеджер по lock-файлу, скрипты установки, переменные без значений', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', postinstall: 'node x.js' }, dependencies: { express: '4' }, devDependencies: { vite: '5' }, engines: { node: '>=20' } }));
    writeFileSync(join(d, 'pnpm-lock.yaml'), '');
    writeFileSync(join(d, '.env.example'), 'PORT=3000\nSECRET_KEY=super-secret-value\n# comment\n');
    const r = inspectProject(d);
    assert.equal(r.packageManager, 'pnpm');
    assert.ok(r.hasLockfile && r.runnable);
    assert.deepEqual(r.installScripts, ['postinstall']);
    assert.deepEqual(r.envVars, ['PORT', 'SECRET_KEY']);
    assert.ok(!JSON.stringify(r).includes('super-secret-value'), 'значения из образца не должны попадать в осмотр');
    assert.ok(r.stack.includes('Express') && r.stack.includes('Vite'));
    assert.equal(r.nodeEngine, '>=20');
  } finally {
    rmSync(d, RM);
  }
});

test('осмотр: без lock-файла предупреждает, чужой стек отмечает, пустая папка — непонятно что', () => {
  const d = tmp();
  const e = tmp();
  try {
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { start: 'node a.js' } }));
    writeFileSync(join(d, 'go.mod'), 'module x');
    const r = inspectProject(d);
    assert.equal(r.packageManager, 'npm');
    assert.ok(r.notes.some((n) => n.includes('lock')));
    assert.ok(r.notes.some((n) => n.includes('не-Node')));
    assert.ok(inspectProject(e).notes.some((n) => n.includes('Не понял')));
    writeFileSync(join(e, 'index.html'), '<html></html>');
    assert.ok(inspectProject(e).runnable);
  } finally {
    rmSync(d, RM);
    rmSync(e, RM);
  }
});

test('установка всегда с отключёнными скриптами', () => {
  for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    for (const lock of [true, false]) assert.ok(installCommand(pm, lock).args.includes('--ignore-scripts'), `${pm} ${lock}`);
  }
  assert.equal(installCommand('npm', true).args[0], 'ci');
  assert.equal(installCommand('npm', false).args[0], 'install');
});

test('.env из образца создаётся только если .env нет и ничего не затирает', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, '.env.example'), 'A=1\n');
    assert.equal(createEnvFromExample(d, '.env.example'), true);
    assert.equal(readFileSync(join(d, '.env'), 'utf8'), 'A=1\n');
    writeFileSync(join(d, '.env'), 'A=my-real\n');
    assert.equal(createEnvFromExample(d, '.env.example'), false);
    assert.equal(readFileSync(join(d, '.env'), 'utf8'), 'A=my-real\n');
  } finally {
    rmSync(d, RM);
  }
});

test('zip: распаковка, подъём единственной внешней папки', async () => {
  const d = tmp();
  try {
    const src = join(d, 'src', 'myapp');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'index.html'), 'hi');
    const zip = join(d, 'a.zip');
    const mk = spawnSync(tarBin(), ['-a', '-cf', zip, '-C', join(d, 'src'), 'myapp']);
    assert.equal(mk.status, 0, 'tar не смог собрать zip для теста');
    const dest = join(d, 'out');
    assert.equal(await extractZip(zip, dest, () => {}), true);
    assert.ok(existsSync(join(dest, 'index.html')), 'проект должен лежать прямо в папке, без лишней вложенности');
  } finally {
    rmSync(d, RM);
  }
});

test('символические ссылки в распакованном удаляются', (t) => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'real.txt'), 'x');
    try {
      symlinkSync(join(d, 'real.txt'), join(d, 'link.txt'));
    } catch {
      t.skip('нет прав на создание symlink');
      return;
    }
    assert.equal(dropSymlinks(d), 1);
    assert.ok(!existsSync(join(d, 'link.txt')));
    assert.ok(existsSync(join(d, 'real.txt')));
  } finally {
    rmSync(d, RM);
  }
});
