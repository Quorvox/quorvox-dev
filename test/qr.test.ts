import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from '../src/qr.ts';

test('qr: для адреса получается SVG-картинка, разные адреса дают разные коды', () => {
  const a = qrSvg('http://192.168.0.5:13410');
  const b = qrSvg('http://192.168.0.5:13411');
  assert.ok(a.startsWith('<svg'));
  assert.ok(a.includes('</svg>'));
  assert.ok((a.match(/M\d+,\d+/g) ?? []).length > 100, 'в коде сотни закрашенных клеток (рисуются одним path)');
  assert.notEqual(a, b);
  assert.equal(a, qrSvg('http://192.168.0.5:13410'), 'один и тот же адрес даёт один и тот же код');
});

test('qr: адрес подлиннее тоже помещается', () => {
  const long = qrSvg('http://192.168.100.200:13410/some/long/path?with=query&and=more&params=1234567890');
  assert.ok(long.startsWith('<svg'));
});
