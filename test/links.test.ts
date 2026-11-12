import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLinks } from '../src/links.ts';
import { collectWeb } from '../src/webfiles.ts';
import { analyzeProject } from '../src/checks.ts';

function write(dir: string, rel: string, text = 'x') {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

function site() {
  const dir = mkdtempSync(join(tmpdir(), 'qv-links-'));
  write(dir, 'index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="css/style.css?v=3">
<link rel="stylesheet" href="css/missing.css">
<script src="/js/app.js"></script>
</head><body>
<img src="img/Logo.png" alt="">
<img src="/avatars/u.png" alt="">
<img src="data:image/png;base64,AAAA">
<a href="about.html">О нас</a>
<a href="contact.html">Контакты</a>
<a href="#top">наверх</a>
<a href="https://example.com/x.png">внешняя</a>
<a href="mailto:a@b.c">почта</a>
<a href="/login">маршрут сервера без расширения</a>
<!-- <img src="comment-only.png"> -->
<img src="{{ user.avatar }}.png">
</body></html>`);
  write(dir, 'about.html', '<p>О нас</p>');
  write(dir, 'css/style.css', `@font-face { src: url("../fonts/f.woff2"); }
body { background: url(../img/logo.png); }
.x { background: url(data:image/png;base64,AAA); }
/* url(commented.png) */`);
  write(dir, 'js/app.js', 'console.log(1)');
  write(dir, 'img/logo.png', 'png');
  return dir;
}

test('ссылки: находит отсутствующие файлы и разницу в регистре, не трогает внешнее, якоря, маршруты и шаблоны', () => {
  const dir = site();
  try {
    const found = checkLinks(dir, collectWeb(dir), false);
    const msgs = found.map((f) => f.message);
    assert.ok(msgs.some((m) => m.includes('css/missing.css') && m.includes('такого файла нет')), 'нет css/missing.css');
    assert.ok(msgs.some((m) => m.includes('contact.html') && m.includes('такого файла нет')), 'нет contact.html');
    assert.ok(msgs.some((m) => m.includes('/avatars/u.png')), 'без сервера /avatars/u.png — битая');
    assert.ok(msgs.some((m) => m.includes('fonts/f.woff2')), 'шрифт из CSS');
    const regs = found.filter((f) => f.message.includes('регистр'));
    assert.equal(regs.length, 1);
    assert.ok(regs[0].message.includes('img/Logo.png') && regs[0].message.includes('img/logo.png'), 'Logo.png против logo.png');
    assert.equal(regs[0].file, 'index.html');

    // верные, внешние и служебные ссылки молчат
    for (const quiet of ['css/style.css', 'about.html', '/js/app.js', 'https://example.com/x.png', 'mailto:a@b.c', '#top', '/login', 'comment-only.png', 'commented.png', '{{ user.avatar }}.png', 'data:image/png;base64,AAAA']) {
      assert.ok(!msgs.some((m) => m.includes(`ссылка на ${quiet},`)), quiet);
    }
    assert.equal(found.length, 5, msgs.join('\n'));
    // у каждой находки есть строка
    assert.ok(found.every((f) => f.line && f.line > 0));
    assert.equal(found.find((f) => f.message.includes('missing.css'))!.line, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ссылки: ссылка за пределы папки сайта предупреждает (с диска работает, по адресу сайта нет)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qv-links-'));
  try {
    // две вложенные «сайта» в одной папке: общий fonts лежит снаружи
    write(dir, 'fonts/fonts.css', '@font-face{}');
    write(dir, 'blade/index.html', '<link rel="stylesheet" href="../fonts/fonts.css"><link rel="stylesheet" href="css/own.css">');
    write(dir, 'blade/css/own.css', 'body{}');
    write(dir, 'blade/about/index.html', '<link rel="stylesheet" href="../css/own.css">'); // внутри сайта — нормально
    const msgs = checkLinks(dir, collectWeb(dir), false).map((f) => f.message);
    assert.equal(msgs.length, 1, msgs.join('\n'));
    assert.ok(msgs[0].includes('../fonts/fonts.css') && msgs[0].includes('выходит за пределы папки сайта (blade)'));
    // у проекта с сервером «наружу» бывает нормой (раздаёт сам сервер): не придираемся
    assert.equal(checkLinks(dir, collectWeb(dir), true).length, 0);
    // если корень проекта сам сайт, всё внутри корня на месте
    write(dir, 'index.html', '<link rel="stylesheet" href="fonts/fonts.css">');
    assert.ok(!checkLinks(dir, collectWeb(dir), false).some((f) => f.file === 'index.html'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ссылки: в проекте с сервером /avatars/... не считаем битой (их может отдавать сам сервер)', () => {
  const dir = site();
  try {
    const msgs = checkLinks(dir, collectWeb(dir), true).map((f) => f.message);
    assert.ok(!msgs.some((m) => m.includes('/avatars/u.png')));
    assert.ok(msgs.some((m) => m.includes('contact.html')), 'относительные ссылки проверяем всегда');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ссылки: попадают в общий отчёт проверок как kind «link»', () => {
  const dir = site();
  try {
    const rep = analyzeProject(dir);
    const links = rep.findings.filter((f) => f.kind === 'link');
    assert.ok(links.length >= 4);
    assert.ok(links.every((f) => f.severity === 'warn'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
