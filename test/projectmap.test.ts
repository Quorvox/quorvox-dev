import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap } from '../src/projectmap.ts';

function write(dir: string, rel: string, text: string) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

function shop() {
  const dir = mkdtempSync(join(tmpdir(), 'qv-map-'));
  write(dir, 'public/index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="https://cdn.example.com/lib.css">
<script type="module" src="/js/app.js"></script></head><body></body></html>`);
  write(dir, 'public/css/style.css', 'body { color: red; } .card { margin: 0; } .old { }');
  write(dir, 'public/js/app.js', `import { api } from './util.js';\nimport './views/shop.js';\napi('/me');\ndocument.body.className = 'card';`);
  write(dir, 'public/js/util.js', `export const api = (p, o) => fetch('/api' + p, o);`);
  write(dir, 'public/js/views/shop.js', `import { api } from '../util.js';\napi('/shop/items');\napi('/shop/buy', { method: 'POST' });`);
  write(dir, 'server/index.js', `
const express = require('express');
const app = express();
const shop = require('./shop');
app.get('/api/me', (q, r) => r.json({}));
app.use('/api/shop', shop.router());
app.listen(process.env.PORT || 3000);
`);
  write(dir, 'server/shop.js', `
const express = require('express');
const db = require('./db');
exports.router = () => {
  const r = express.Router();
  r.get('/items', (q, s) => s.json(db.prepare('SELECT * FROM items').all()));
  r.post('/buy', async (q, s) => {
    db.prepare('INSERT INTO orders (item) VALUES (?)').run(1);
    await fetch('https://api.telegram.org/bot/sendMessage');
    s.json({});
  });
  return r;
};
`);
  write(dir, 'server/db.js', `
module.exports = {
  prepare() {},
  init() { this.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER)'); this.exec('CREATE TABLE IF NOT EXISTS orders (id INTEGER)'); this.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER)'); },
};
`);
  return dir;
}

test('карта: страница → стили и скрипты → сервер → таблицы и внешнее', () => {
  const dir = shop();
  try {
    const m = buildMap(dir);
    const ids = m.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, [
      'ext:Telegram',
      'page:public/index.html',
      'script:public/js/app.js',
      'script:public/js/views/shop.js',
      'server:server/index.js',
      'server:server/shop.js',
      'style:public/css/style.css',
      'table:items',
      'table:orders',
    ]);
    const has = (from: string, to: string, kind: string, indirect = false) =>
      m.edges.some((e) => e.from === from && e.to === to && e.kind === kind && !!e.indirect === indirect);

    assert.ok(has('page:public/index.html', 'style:public/css/style.css', 'includes'), 'страница → CSS (из /css/ в public)');
    assert.ok(has('page:public/index.html', 'script:public/js/app.js', 'includes'), 'страница → скрипт напрямую');
    assert.ok(has('page:public/index.html', 'script:public/js/views/shop.js', 'includes', true), 'страница → скрипт через import');
    assert.ok(has('script:public/js/app.js', 'server:server/index.js', 'calls'));
    assert.ok(has('script:public/js/views/shop.js', 'server:server/shop.js', 'calls'));
    assert.equal(m.edges.find((e) => e.from === 'script:public/js/views/shop.js')!.count, 2, 'два запроса в один файл');
    assert.ok(has('server:server/shop.js', 'table:items', 'stores'));
    assert.ok(has('server:server/shop.js', 'table:orders', 'stores'));
    assert.ok(has('server:server/shop.js', 'ext:Telegram', 'talks'));
    // таблица users объявлена, но никем не используется — на карте её нет
    assert.ok(!ids.includes('table:users'));
    // внешний CDN-стиль не считаем файлом проекта
    assert.equal(m.stats.styles, 1);
    // CSS: у файла стилей виден мёртвый класс и список тех, кто им пользуется
    const style = m.nodes.find((n) => n.id === 'style:public/css/style.css')!;
    assert.equal(style.meta, '1 мёртв.');
    assert.deepEqual(style.lists![0].items.map((i) => i.label), ['.old']);
    assert.equal(style.lists![0].items[0].file, 'public/css/style.css');
    assert.ok(style.related!.some((r) => r.id === 'script:public/js/app.js' && r.note === '1 кл.'));
    const app = m.nodes.find((n) => n.id === 'script:public/js/app.js')!;
    assert.ok(app.related!.some((r) => r.id === 'style:public/css/style.css'));
    // счётчики на карточках
    assert.equal(m.nodes.find((n) => n.id === 'server:server/shop.js')!.meta, '2 адр.');
    assert.equal(m.nodes.find((n) => n.id === 'script:public/js/views/shop.js')!.meta, '2 запр.');
    assert.equal(m.nodes.find((n) => n.id === 'table:items')!.meta, '×1');
    // у каждого узла есть пояснение для новичка
    assert.ok(m.nodes.every((n) => n.text.length > 0 && n.text[0].length > 10));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('карта: проект без сервера — просто страницы и стили', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-map-'));
  try {
    write(dir, 'index.html', '<link rel="stylesheet" href="style.css"><script src="main.js"></script>');
    write(dir, 'style.css', 'a { color: blue }');
    write(dir, 'main.js', 'console.log(1)');
    const m = buildMap(dir);
    assert.ok(m.nodes.some((n) => n.kind === 'page'));
    assert.ok(m.nodes.some((n) => n.kind === 'style'));
    assert.ok(!m.nodes.some((n) => n.kind === 'server'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
