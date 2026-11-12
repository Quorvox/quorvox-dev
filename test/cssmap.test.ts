import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCss, parseCssClasses } from '../src/cssmap.ts';
import type { Src } from '../src/checks.ts';
import type { WebFile } from '../src/webfiles.ts';

const web = (rel: string, src: string): WebFile => ({ abs: '/' + rel, rel, src });
const js = (rel: string, src: string): Src => ({ abs: '/' + rel, rel, src, server: false, starts: [0] });

const CSS = `
/* .commented { } */
.card { color: red; }
.card:hover .icon { color: blue; }
.big { }
.dead-one, .dead-two { }
@media (min-width: 0.5em) {
  .mobile-only { display: none; }
}
@keyframes spin { from { opacity: 0.5 } to { opacity: 1 } }
.btn-primary { }
.btn-danger { }
.tab-a { }
a[href$=".pdf"] { background: url(img/bg.png.jpg); }
.clubs { }
`;

const HTML = `<link rel="stylesheet" href="/css/style.css"><div class="card big js-hook">x</div>`;

const APP = `
// .commentedjs
el.classList.add('icon');
const x = \`<span class="btn-\${kind}"></span>\`;
node.className = 'tab-' + id;
el.classList.add('clubz');
`;

test('css: какие классы определены (комментарии, @media, строки и url не мешают) и на каких строках', () => {
  const found = parseCssClasses(web('style.css', CSS));
  const names = found.map((c) => c.name);
  assert.deepEqual([...new Set(names)].sort(), ['big', 'btn-danger', 'btn-primary', 'card', 'clubs', 'dead-one', 'dead-two', 'icon', 'mobile-only', 'tab-a']);
  assert.equal(found.find((c) => c.name === 'card')!.line, 3);
  assert.equal(found.find((c) => c.name === 'mobile-only')!.line, 8);
});

test('css: мёртвые классы, динамические имена, опечатки и кто чем пользуется', () => {
  const rep = analyzeCss({ html: [web('index.html', HTML)], css: [web('style.css', CSS)] }, [js('app.js', APP)]);
  const st = rep.styles.find((s) => s.file === 'style.css')!;
  assert.equal(st.total, 10);
  // btn-primary/btn-danger и tab-a живы благодаря динамическим префиксам; icon — через classList
  assert.deepEqual(st.dead.map((c) => c.name).sort(), ['clubs', 'dead-one', 'dead-two', 'mobile-only']);
  // кто сколько классов из этого файла использует
  const by = Object.fromEntries(st.usedBy.map((u) => [u.file, u.count]));
  assert.equal(by['index.html'], 2); // card, big
  assert.equal(by['app.js'], 1); // icon
  // опечатка: clubz → clubs
  assert.equal(rep.typos.length, 1);
  assert.equal(rep.typos[0].name, 'clubz');
  assert.equal(rep.typos[0].like, 'clubs');
  assert.equal(rep.typos[0].file, 'app.js');
  assert.equal(rep.externalCss, false);
});

test('css: классы библиотек и нумерованные классы не считаются мёртвыми', () => {
  const css = `
cg-board square.last-move { }
.leaflet-tooltip { }
.top1 { } .top2 { }
.rank-1 { }
.really-dead { }
`;
  const code = `const c = 'top' + (i + 1); const r = 'rank-' + n;`;
  const rep = analyzeCss({ html: [web('i.html', '<p>x</p>')], css: [web('s.css', css)] }, [js('a.js', code)]);
  const st = rep.styles[0];
  assert.deepEqual(st.dead.map((c) => c.name), ['really-dead']);
  assert.equal(st.total, 6);
});

test('css: опечатки с расстоянием запоминаются, чтобы отличать вероятные от возможных', () => {
  const rep = analyzeCss(
    { html: [web('i.html', '<div class="clubz"></div>')], css: [web('s.css', '.clubs { }')] },
    [],
  );
  assert.equal(rep.typos[0].dist, 1);
});

test('css: флаг состояния (toggle) — слабая опечатка, класс на элементе — сильная', () => {
  const rep = analyzeCss(
    { html: [web('i.html', '<p>x</p>')], css: [web('s.css', '.px-pause { } .clubs-list { }')] },
    [js('a.js', `document.body.classList.toggle('px-paused', on); el.className = 'clubs-lisr';`)],
  );
  const by = Object.fromEntries(rep.typos.map((t) => [t.name, t.strong]));
  assert.equal(by['px-paused'], false);
  assert.equal(by['clubs-lisr'], true);
});

test('css: нет CSS или нет кода — ничего не придумываем', () => {
  assert.deepEqual(analyzeCss({ html: [], css: [] }, []).styles, []);
  assert.deepEqual(analyzeCss({ html: [], css: [web('a.css', '.x{}')] }, []).styles, []);
});

test('css: внешний стиль с CDN помечается', () => {
  const rep = analyzeCss(
    { html: [web('i.html', '<link rel="stylesheet" href="https://cdn.example.com/x.css"><div class="card"></div>')], css: [web('s.css', '.card{}')] },
    [],
  );
  assert.equal(rep.externalCss, true);
});
