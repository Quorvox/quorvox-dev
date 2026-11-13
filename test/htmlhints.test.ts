import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHtml } from '../src/htmlhints.ts';

const page = (src: string) => [{ abs: '/x/index.html', rel: 'index.html', src }];

test('вёрстка: полная страница без alt, viewport, lang, title и noopener даёт подсказки', () => {
  const f = checkHtml(page('<!doctype html><html><head></head><body>\n<img src="a.png">\n<a href="x" target="_blank">x</a></body></html>'));
  const msgs = f.map((x) => x.message).join('\n');
  assert.match(msgs, /alt/);
  assert.match(msgs, /viewport/);
  assert.match(msgs, /lang/);
  assert.match(msgs, /title/);
  assert.match(msgs, /noopener/);
  assert.equal(f.find((x) => /alt/.test(x.message))?.line, 2);
  assert.equal(f.find((x) => /alt/.test(x.message))?.ref, '<img src="a.png">');
});

test('вёрстка: аккуратная страница и куски шаблонов (без <html>) не трогаются', () => {
  const good = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>T</title></head><body><img src="a.png" alt="лого"><a target="_blank" rel="noopener noreferrer" href="x">x</a></body></html>';
  assert.deepEqual(checkHtml(page(good)), []);
  assert.deepEqual(checkHtml(page('<div><img src="a.png"></div>')), []);
});

test('вёрстка: закомментированное не проверяется', () => {
  const src = '<!doctype html><html lang="ru"><head><meta name="viewport" content="x"><title>T</title></head><body><!-- <img src="a.png"> --></body></html>';
  assert.deepEqual(checkHtml(page(src)), []);
});
