import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classContext,
  apiContext,
  envContext,
  routeItems,
  insertPath,
  classAtCursor,
  envAtCursor,
  apiPathAtCursor,
  routesForPath,
  cssRuleAt,
} from '../src/editorlogic.ts';
import type { EditorIndex } from '../src/checks.ts';

const index: EditorIndex = {
  classes: [],
  apiPrefix: '/api',
  env: [],
  routes: [
    { method: 'GET', full: '/api/clubs', file: 'server/clubs.js', line: 10 },
    { method: 'POST', full: '/api/clubs', file: 'server/clubs.js', line: 12 },
    { method: 'GET', full: '/api/clubs/:id', file: 'server/clubs.js', line: 20 },
    { method: 'POST', full: '/api/clubs/:id/join', file: 'server/clubs.js', line: 30 },
    { method: 'GET', full: '/auth/logout', file: 'server/auth.js', line: 5 },
  ],
};

test('редактор: где набирается класс', () => {
  assert.deepEqual(classContext('<div class="'), { prefix: '' });
  assert.deepEqual(classContext('<div class="card bi'), { prefix: 'bi' });
  assert.deepEqual(classContext('<div id="x" class=\'a b '), { prefix: '' });
  assert.deepEqual(classContext('const h = `<p class=\\"ca'), { prefix: 'ca' }, 'HTML внутри строки JS с экранированными кавычками');
  assert.deepEqual(classContext("el.className = 'btn pr"), { prefix: 'pr' });
  assert.deepEqual(classContext("el.classList.add('ac"), { prefix: 'ac' });
  assert.deepEqual(classContext("el.classList.toggle('on', "), null, 'после запятой вне кавычек — не класс');
  assert.deepEqual(classContext("document.querySelector('.card .ti"), { prefix: 'ti' });
  assert.equal(classContext("document.querySelector('div"), null, 'селектор без точки — не класс');
  assert.equal(classContext('<div id="ca'), null, 'это id, не class');
  assert.equal(classContext('<div class="card">'), null, 'кавычка уже закрыта');
  assert.equal(classContext('const subclass = "ca'), null);
});

test('редактор: где набирается адрес API и переменная окружения', () => {
  assert.deepEqual(apiContext("await api('"), { kind: 'api', typed: '', quote: "'" });
  assert.deepEqual(apiContext('api(`/clu'), { kind: 'api', typed: '/clu', quote: '`' });
  assert.deepEqual(apiContext("fetch('/api/cl"), { kind: 'fetch', typed: '/api/cl', quote: "'" });
  assert.equal(apiContext("fetch('https://x.com/a"), null, 'внешний адрес не трогаем');
  assert.equal(apiContext("api('/clubs', {"), null, 'строка уже закрыта');
  assert.equal(apiContext("rapi('/"), null, 'другое слово');
  assert.deepEqual(envContext('const t = process.env.TELE'), { prefix: 'TELE' });
  assert.deepEqual(envContext('process.env.'), { prefix: '' });
  assert.equal(envContext('process.env["X'), null);
});

test('редактор: что предложить для api() и fetch() (префикс /api, методы, params)', () => {
  const api = routeItems(index, { kind: 'api', typed: '', quote: "'" });
  assert.deepEqual(api.map((i) => i.path), ['/clubs', '/clubs/:id', '/clubs/:id/join'], 'без префикса /api, чужие маршруты не лезут');
  assert.deepEqual(api[0].methods, ['GET', 'POST'], 'методы одного адреса склеены');
  assert.equal(api[0].line, 10);

  const fetchItems = routeItems(index, { kind: 'fetch', typed: '/', quote: "'" });
  assert.deepEqual(fetchItems.map((i) => i.path), ['/api/clubs', '/api/clubs/:id', '/api/clubs/:id/join', '/auth/logout'], 'для fetch — полные адреса');

  assert.equal(insertPath(api[1], "'"), '/clubs/:id');
  assert.equal(insertPath(api[1], '`'), '/clubs/${id}', 'в обратных кавычках :id становится подстановкой');
  assert.equal(insertPath(api[2], '`'), '/clubs/${id}/join');
});

test('редактор: слово под курсором', () => {
  const line = '<div class="card big-title" id="x">';
  const at = (word: string) => line.indexOf(word) + 1;
  assert.deepEqual(classAtCursor(line, at('card')), { name: 'card', start: 12, end: 16 });
  assert.equal(classAtCursor(line, at('big-title'))!.name, 'big-title', 'дефис — часть имени');
  assert.equal(classAtCursor(line, at('id="x"')), null, 'не класс');
  assert.equal(classAtCursor('const card = 1;', 8), null);
  assert.equal(classAtCursor("document.querySelector('.card')", 26)!.name, 'card');

  assert.deepEqual(envAtCursor('const t = process.env.BOT_TOKEN || "";', 25), { name: 'BOT_TOKEN', start: 10, end: 31 });
  assert.equal(envAtCursor("process.env['SMTP_URL']", 15)!.name, 'SMTP_URL');
  assert.equal(envAtCursor('const t = 1;', 3), null);

  assert.deepEqual(apiPathAtCursor("api('/clubs/1?x=2')", 8), { kind: 'api', path: '/clubs/1' });
  assert.deepEqual(apiPathAtCursor('await fetch(`/api/clubs/${id}`)', 22), { kind: 'fetch', path: '/api/clubs/${id}' });
  assert.equal(apiPathAtCursor("api('/clubs')", 1), null, 'курсор не на строке');
  assert.equal(apiPathAtCursor("fetch('https://x.com/a')", 12), null);
});

test('редактор: какие маршруты подходят под путь (${x} и :id — любое значение)', () => {
  const m = (kind: 'api' | 'fetch', path: string) => routesForPath(index, { kind, path }).map((r) => `${r.method} ${r.full}`);
  assert.deepEqual(m('api', '/clubs'), ['GET /api/clubs', 'POST /api/clubs']);
  assert.deepEqual(m('api', '/clubs/${id}'), ['GET /api/clubs/:id']);
  assert.deepEqual(m('api', '/clubs/42/join'), ['POST /api/clubs/:id/join']);
  assert.deepEqual(m('fetch', '/api/clubs/7'), ['GET /api/clubs/:id']);
  assert.deepEqual(m('api', '/clubz'), []);
  assert.deepEqual(m('fetch', '/auth/logout'), ['GET /auth/logout']);
});

test('редактор: кусок CSS-правила для подсказки', () => {
  const css = ['a { color: red; }', '.card {', '  color: blue;', '  padding: 4px;', '}', '.next { }'].join('\n');
  assert.equal(cssRuleAt(css, 2), '.card {\n  color: blue;\n  padding: 4px;\n}');
  assert.equal(cssRuleAt(css, 1), 'a { color: red; }');
  assert.equal(cssRuleAt('.x {\n' + 'a: b;\n'.repeat(40), 1, 5).split('\n').length, 5, 'длинное правило режется');
});
