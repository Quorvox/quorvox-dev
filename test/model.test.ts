import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer } from '../src/logbuf.ts';
import { snapshot } from '../src/model.ts';
import { Stack } from '../src/stack.ts';

test('буфер логов: срезает ANSI-цвета и держит только последние строки', () => {
  const b = new LogBuffer(3);
  assert.equal(b.push('api', '\u001b[31mошибка\u001b[0m').text, 'ошибка');
  b.push('api', '2');
  b.push('api', '3');
  b.push('web', '4');
  assert.deepEqual(b.all().map((l) => l.text), ['2', '3', '4']);
  b.clear();
  assert.equal(b.all().length, 0);
});

test('снимок: путь относительно корня, адрес только когда есть прокси', () => {
  const stack = new Stack([
    { name: 'api', cwd: 'A:\\p\\app\\server', command: 'npm run start', selfWatch: false, liveReload: true },
    { name: 'web', cwd: 'A:\\p\\app', command: 'npm run dev', selfWatch: true, liveReload: false },
  ]);
  const s = snapshot(stack, 'A:\\p\\app');
  assert.equal(s.length, 2);
  assert.equal(s[0].status, 'stopped');
  assert.equal(s[0].url, null);
  assert.equal(s[0].autoRestart, true);
  assert.equal(s[1].autoRestart, false);
  assert.equal(snapshot(null).length, 0);
});
