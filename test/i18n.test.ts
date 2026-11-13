import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tr, setLang, getLang, resolveLang, plural } from '../src/i18n.ts';
import { EN } from '../src/i18n-en.ts';
import { localizeHtml } from '../src/webi18n.ts';
import { dashboardHtml } from '../src/dashboard-html.ts';
import { mapHtml } from '../src/map-html.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const CYR = /[А-Яа-яЁё]/;

function usedKeys(): { file: string; key: string; template: boolean }[] {
  const out: { file: string; key: string; template: boolean }[] = [];
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts') && !x.startsWith('i18n') && x !== 'webi18n.ts')) {
    const src = readFileSync(join(SRC, f), 'utf8');
    for (const m of src.matchAll(/(?<![\w.$])(?:tr|N)\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
      const raw = m[2];
      const template = m[1] === '`' && raw.includes('${');
      let key = raw;
      try {
        key = new Function('return ' + m[1] + raw + m[1])() as string;
      } catch {
        // оставляем как есть
      }
      out.push({ file: f, key, template });
    }
  }
  return out;
}

test('язык: авто — русский VS Code даёт русский, всё остальное английский', () => {
  assert.equal(resolveLang('auto', 'ru'), 'ru');
  assert.equal(resolveLang('auto', 'ru-RU'), 'ru');
  assert.equal(resolveLang(undefined, 'en'), 'en');
  assert.equal(resolveLang('auto', 'de'), 'en');
  assert.equal(resolveLang('auto', 'zh-cn'), 'en');
  assert.equal(resolveLang('ru', 'en'), 'ru');
  assert.equal(resolveLang('en', 'ru'), 'en');
});

test('tr: подстановки и запасной вариант (нет перевода — показываем исходную строку)', () => {
  const was = getLang();
  try {
    setLang('en');
    assert.equal(tr('Откатить'), 'Roll back');
    assert.equal(tr('Выложить проект на {0}@{1}?', 'root', 'host'), 'Deploy the project to root@host?');
    assert.equal(tr('Строки нет в словаре {0}', 5), 'Строки нет в словаре 5');
    setLang('ru');
    assert.equal(tr('Откатить'), 'Откатить');
    assert.equal(tr('Выложить проект на {0}@{1}?', 'root', 'host'), 'Выложить проект на root@host?');
  } finally {
    setLang(was);
  }
});

test('plural: русские формы и английские', () => {
  const was = getLang();
  try {
    setLang('ru');
    const f = (n: number) => plural(n, ['файл', 'файла', 'файлов'], ['file', 'files']);
    assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 111].map(f), ['файл', 'файла', 'файлов', 'файлов', 'файл', 'файла', 'файлов', 'файлов']);
    setLang('en');
    assert.equal(plural(1, ['файл', 'файла', 'файлов'], ['file', 'files']), 'file');
    assert.equal(plural(3, ['файл', 'файла', 'файлов'], ['file', 'files']), 'files');
  } finally {
    setLang(was);
  }
});

test('каждая строка из tr(…) / N(…) в коде есть в английском словаре, а плейсхолдеры совпадают', () => {
  const missing: string[] = [];
  const badTemplates: string[] = [];
  for (const u of usedKeys()) {
    if (!CYR.test(u.key)) continue;
    if (u.template) badTemplates.push(`${u.file}: ${u.key.slice(0, 60)}`);
    else if (!(u.key in EN)) missing.push(`${u.file}: ${u.key.slice(0, 80)}`);
  }
  assert.deepEqual(badTemplates, [], 'внутри tr(…) нельзя ${…}: используй {0}');
  assert.deepEqual(missing, [], 'нет перевода');
  for (const [ru, en] of Object.entries(EN)) {
    const a = (ru.match(/\{\d+\}/g) ?? []).sort().join();
    const b = (en.match(/\{\d+\}/g) ?? []).sort().join();
    assert.equal(b, a, `плейсхолдеры не совпали: ${ru.slice(0, 60)}`);
    assert.ok(!CYR.test(en), `в английском есть русские буквы: ${en.slice(0, 60)}`);
  }
});

// русские буквы вне комментариев
function cyrillicOutsideComments(html: string): string[] {
  const clean = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return clean.split('\n').filter((l) => CYR.test(l.replace(/\s\/\/.*$/, '')));
}

test('вёрстка дашборда и карты на английском: русских букв не остаётся', () => {
  const was = getLang();
  try {
    setLang('en');
    for (const [name, html] of [['дашборд', dashboardHtml('n')], ['карта', mapHtml('n')]] as const) {
      const left = cyrillicOutsideComments(localizeHtml(html));
      assert.deepEqual(left.map((l) => l.trim().slice(0, 120)), [], `в вёрстке «${name}» остался русский`);
    }
    setLang('ru');
    assert.equal(localizeHtml(dashboardHtml('n')), dashboardHtml('n'), 'по-русски вёрстка не меняется');
  } finally {
    setLang(was);
  }
});
