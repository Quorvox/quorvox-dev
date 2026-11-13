import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMove, applyToDisk, makeSnapshot, undoSnapshot } from '../src/mover.ts';
import { analyzeProject } from '../src/checks.ts';

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 150 } as const;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'qv-move-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

// проект как у подруги: public + server, Express отдаёт public
const EXPRESS = {
  'server/index.js': "const express = require('express');\nconst path = require('path');\nconst app = express();\napp.use(express.static(path.join(__dirname, '..', 'public')));\napp.get('/api/clubs', (req, res) => res.json([]));\napp.listen(3000);\n",
  'public/index.html': '<!doctype html><html><head><link rel="stylesheet" href="/css/style.css"><script src="/js/app.js"></script></head><body><img src="img/logo.png"></body></html>',
  'public/css/style.css': "body { background: url('../img/bg.png'); }\n@import 'extra.css';\n",
  'public/css/extra.css': '.card { padding: 4px; }\n',
  'public/js/app.js': "import { u } from './util';\nfetch('/api/clubs');\n",
  'public/js/util.js': 'export const u = 1;\n',
  'public/img/bg.png': 'x',
  'public/img/logo.png': 'x',
};

test('папка css из public наружу: сервер получает новую отдачу, ссылки в HTML меняются', () => {
  const root = project(EXPRESS);
  try {
    const plan = planMove(root, [{ from: join(root, 'public/css'), to: join(root, 'styles') }]);
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.inserts.length, 1);
    assert.match(plan.inserts[0].text, /app\.use\('\/styles', express\.static\(__dirname \+ '\/..\/styles'\)\)/);
    const html = plan.edits.find((e) => e.file.endsWith('index.html'));
    assert.equal(html?.newText, '/styles/style.css');
    applyToDisk(plan);
    assert.ok(existsSync(join(root, 'styles/style.css')));
    assert.match(read(root, 'public/index.html'), /href="\/styles\/style\.css"/);
    // стили внутри переехавшей папки: путь к картинке пересчитан
    assert.match(read(root, 'styles/style.css'), /url\('\.\.\/public\/img\/bg\.png'\)/);
    assert.match(read(root, 'styles/style.css'), /@import 'extra\.css'/);
    assert.match(read(root, 'server/index.js'), /express\.static\(__dirname \+ '\/\.\.\/styles'\)/);
  } finally {
    rmSync(root, RM);
  }
});

test('перенос внутри отдаваемой папки: меняется только адрес, сервер не трогаем', () => {
  const root = project(EXPRESS);
  try {
    const plan = planMove(root, [{ from: join(root, 'public/css'), to: join(root, 'public/assets/css') }]);
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.inserts.length, 0);
    applyToDisk(plan);
    assert.match(read(root, 'public/index.html'), /href="\/assets\/css\/style\.css"/);
    assert.match(read(root, 'public/assets/css/style.css'), /url\('\.\.\/\.\.\/img\/bg\.png'\)/);
  } finally {
    rmSync(root, RM);
  }
});

test('JS: перенос файла чинит импорт без расширения и сохраняет стиль ./', () => {
  const root = project(EXPRESS);
  try {
    const plan = planMove(root, [{ from: join(root, 'public/js/util.js'), to: join(root, 'public/js/lib/util.js') }]);
    assert.deepEqual(plan.errors, []);
    applyToDisk(plan);
    assert.match(read(root, 'public/js/app.js'), /from '\.\/lib\/util'/);
  } finally {
    rmSync(root, RM);
  }
});

test('статический сайт: переименование папки css в styles чинит относительные ссылки', () => {
  const root = project({
    'index.html': '<link rel="stylesheet" href="css/main.css?v=3"><link href="./css/main.css#x">',
    'css/main.css': 'a{}',
    'about/index.html': '<link rel="stylesheet" href="../css/main.css">',
  });
  try {
    const plan = planMove(root, [{ from: join(root, 'css'), to: join(root, 'styles') }]);
    assert.deepEqual(plan.errors, []);
    applyToDisk(plan);
    assert.equal(read(root, 'index.html'), '<link rel="stylesheet" href="styles/main.css?v=3"><link href="./styles/main.css#x">');
    assert.match(read(root, 'about/index.html'), /href="\.\.\/styles\/main\.css"/);
  } finally {
    rmSync(root, RM);
  }
});

test('ошибки: наружу проекта, в себя, поверх существующего, несуществующий', () => {
  const root = project(EXPRESS);
  try {
    const p = (from: string, to: string) => planMove(root, [{ from: join(root, from), to: to.startsWith('/') ? to : join(root, to) }]);
    assert.ok(p('public/css', 'public/css/inner').errors.length);
    assert.ok(p('public/css', 'public/js').errors.length);
    assert.ok(p('public/nope', 'x').errors.length);
    assert.ok(planMove(root, [{ from: join(root, 'public/css'), to: join(root, '..', 'outside') }]).errors.length);
  } finally {
    rmSync(root, RM);
  }
});

test('упоминание старого пути в конфиге попадает в предупреждения, а не правится', () => {
  const root = project({ ...EXPRESS, 'package.json': '{"scripts":{"lint":"stylelint public/css/*.css"}}' });
  try {
    const plan = planMove(root, [{ from: join(root, 'public/css'), to: join(root, 'styles') }]);
    assert.ok(plan.mentions.some((m) => m.file === 'package.json'));
  } finally {
    rmSync(root, RM);
  }
});

test('после переноса проверки проекта не находят новых битых ссылок, откат возвращает всё как было', () => {
  const root = project(EXPRESS);
  try {
    const snapshotBefore = Object.fromEntries(Object.keys(EXPRESS).map((k) => [k, read(root, k)]));
    const countBroken = () => analyzeProject(root, []).findings.filter((f) => /ссыл|файл|нет такого/i.test(f.message)).length;
    const before = countBroken();
    const plan = planMove(root, [{ from: join(root, 'public/css'), to: join(root, 'styles') }]);
    const snap = makeSnapshot(plan);
    applyToDisk(plan);
    assert.ok(countBroken() <= before, 'после переноса появились битые ссылки');
    undoSnapshot(snap);
    for (const [k, text] of Object.entries(snapshotBefore)) assert.equal(read(root, k), text, k);
    assert.ok(!existsSync(join(root, 'styles')));
  } finally {
    rmSync(root, RM);
  }
});
