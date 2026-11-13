// Запуск теста внутри настоящего VS Code: отдельный экземпляр с чистым профилем (основной не затрагивается).
//   npm run test:vscode
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, '..');
const work = mkdtempSync(join(tmpdir(), 'qv-vscode-'));
const fixture = join(work, 'site');
const result = join(work, 'result.json');

function write(rel, text) {
  const full = join(fixture, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
}

// мини-проект: express-сервер, страница, стили и скрипт с опечаткой в адресе API
write('package.json', JSON.stringify({ name: 'fx', scripts: { start: 'node server/index.js' } }));
write(
  'server/index.js',
  [
    "const express = require('express');",
    'const app = express();',
    "app.get('/api/clubs', (q, r) => r.json([]));",
    "app.post('/api/clubs/:id/join', (q, r) => r.json({}));",
    'app.listen(process.env.PORT || 3000);',
    '',
  ].join('\n'),
);
write('public/js/util.js', "export const api = (p, o) => fetch('/api' + p, o);\n");
write('public/js/app.js', ["import { api } from './util.js';", "api('/clubs');", "api('/clubz');", "api('');", ''].join('\n'));
write('public/css/style.css', ['.card {', '  color: red;', '  padding: 4px;', '}', '.btn-main { color: blue; }', ''].join('\n'));
write(
  'public/index.html',
  [
    '<!doctype html><html><head><link rel="stylesheet" href="css/style.css"></head><body>',
    '<div class="card">ok</div>',
    '<div class="cardd">опечатка</div>',
    '<div class="">сюда набираем</div>',
    '<script type="module" src="js/app.js"></script></body></html>',
    '',
  ].join('\n'),
);

// где лежит Code.exe
const codeCmd = execSync('where code', { encoding: 'utf8' }).split(/\r?\n/).find((l) => /code\.cmd$/i.test(l.trim()))?.trim();
const exe = process.env.QV_CODE_EXE || (codeCmd ? join(dirname(dirname(codeCmd)), 'Code.exe') : '');
if (!exe || !existsSync(exe)) {
  console.error('не нашёл Code.exe (задай QV_CODE_EXE)');
  process.exit(2);
}

// чужие переменные окружения мешают: в терминале VS Code и в Electron-приложениях они выставлены
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|VSCODE_)/.test(k)));
env.QV_RESULT = result;

const args = [
  `--user-data-dir=${join(work, 'user')}`,
  `--extensions-dir=${join(work, 'ext')}`,
  `--extensionDevelopmentPath=${ext}`,
  `--extensionTestsPath=${join(here, 'suite.cjs')}`,
  '--locale=ru',
  '--disable-extensions',
  '--disable-workspace-trust',
  '--disable-telemetry',
  '--skip-release-notes',
  '--skip-welcome',
  '--new-window',
  fixture,
];

console.log('запускаю отдельный VS Code (чистый профиль), это около минуты…');
const child = spawn(exe, args, { env, stdio: 'ignore' });
const timer = setTimeout(() => {
  console.error('таймаут 3 минуты: закрываю');
  child.kill();
}, 180000);
child.on('exit', (code) => {
  clearTimeout(timer);
  let res = null;
  try {
    res = JSON.parse(readFileSync(result, 'utf8'));
  } catch {
    // результата нет
  }
  if (!res) {
    console.error(`результата нет (код выхода ${code}): VS Code не дошёл до конца тестов`);
  } else {
    for (const s of res.steps) console.log(`${s.ok ? '✔' : '✖'} ${s.name}${s.detail ? '\n     ' + s.detail : ''}`);
    console.log(res.ok ? `\nВСЁ ПРОШЛО (${res.steps.length} шагов)` : '\nЕСТЬ ПАДЕНИЯ');
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(res && res.ok ? 0 : 1);
});
