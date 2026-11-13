import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tr } from './i18n.ts';
import { analyzeProject } from './checks.ts';
import { fromPython } from './detect.ts';

// Импорт чужого проекта (GitHub или zip): скачать, осмотреть, подготовить к запуску.
// Ничего чужого здесь не запускается: ни скрипты проекта, ни установка. Это делает мастер после явного «да».

const HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'];

export interface RepoRef {
  url: string;
  name: string;
}

// только https и известные хостинги; никаких file:, ssh, опций вида --upload-pack=…
export function parseRepoUrl(input: string): RepoRef | { error: string } {
  const s = input.trim();
  const m = /^https:\/\/([a-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(s);
  if (!m) return { error: tr('Нужна ссылка вида https://github.com/автор/проект') };
  const host = m[1].toLowerCase();
  if (!HOSTS.includes(host)) return { error: tr('Беру только {0}. Для другого хостинга скачай zip и выбери «Архив zip».', HOSTS.join(', ')) };
  if (m[2].startsWith('.') || m[3].startsWith('.')) return { error: tr('Странное имя в ссылке') };
  return { url: `https://${host}/${m[2]}/${m[3]}.git`, name: safeName(m[3]) };
}

// имя папки: буквы, цифры, точка, дефис, подчёркивание; без «..» и пустоты
export function safeName(raw: string): string {
  const n = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/-+$/, '').slice(0, 60);
  return n || 'project';
}

// свободное имя рядом: name, name-2, name-3 …
export function freeDir(parent: string, name: string): string {
  let dir = join(parent, name);
  for (let i = 2; existsSync(dir); i++) dir = join(parent, `${name}-${i}`);
  return dir;
}

function run(cmd: string, args: string[], cwd: string | undefined, onLine: (l: string) => void, timeoutMs = 300_000): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const t = setTimeout(() => p.kill(), timeoutMs);
    const feed = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => {
      clearTimeout(t);
      onLine(tr('не удалось запустить {0}: {1}', cmd, e.message));
      resolve(-1);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code ?? -1);
    });
  });
}

export async function cloneRepo(ref: RepoRef, dest: string, onLine: (l: string) => void): Promise<boolean> {
  // `--` отделяет ссылку от опций; submodules не тянем, символические ссылки не создаём
  const code = await run('git', ['-c', 'core.symlinks=false', 'clone', '--depth', '1', '--', ref.url, dest], undefined, onLine);
  if (code !== 0) {
    rmSync(dest, { recursive: true, force: true });
    return false;
  }
  rmSync(join(dest, '.git', 'hooks'), { recursive: true, force: true }); // чужие хуки нам не нужны
  return true;
}

// все символические ссылки внутри папки удаляем: распакованный архив не должен вести за её пределы
export function dropSymlinks(dir: string): number {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        rmSync(p, { force: true });
        n++;
      } else if (st.isDirectory()) stack.push(p);
    }
  }
  return n;
}

// на Windows берём системный tar (bsdtar, умеет zip): в PATH из Git Bash первым может стоять GNU tar, а он zip не читает
export function tarBin(): string {
  if (process.platform === 'win32') {
    const sys = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe');
    if (existsSync(sys)) return sys;
  }
  return 'tar';
}

export async function extractZip(zip: string, dest: string, onLine: (l: string) => void): Promise<boolean> {
  mkdirSync(dest, { recursive: true });
  // tar на Windows 10+ (bsdtar) умеет zip; пути с «..» и абсолютные он сам отбрасывает
  const code = await run(tarBin(), ['-xf', zip, '-C', dest], undefined, onLine);
  if (code !== 0) {
    rmSync(dest, { recursive: true, force: true });
    return false;
  }
  const dropped = dropSymlinks(dest);
  if (dropped) onLine(tr('в архиве были символические ссылки ({0}), я их удалил: они могли вести за пределы папки', dropped));
  // если внутри одна папка — проект лежит в ней, поднимаем содержимое наверх
  const items = readdirSync(dest);
  if (items.length === 1 && lstatSync(join(dest, items[0])).isDirectory()) {
    const inner = join(dest, items[0]);
    const tmp = dest + '.tmp-' + process.pid;
    renameSync(inner, tmp);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  }
  return true;
}

export function zipName(zip: string): string {
  return safeName(basename(zip, extname(zip)));
}

// ---------- осмотр проекта ----------

export interface Inspection {
  stack: string[]; // что это за проект
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  hasLockfile: boolean;
  scripts: string[]; // имена скриптов (dev, start …)
  installScripts: string[]; // скрипты, которые npm запускает при установке (их мы отключаем)
  depCount: number;
  nodeEngine: string | null;
  envExample: string | null; // имя файла-образца
  envExists: boolean;
  envVars: string[]; // имена переменных из образца (значений не читаем и не показываем)
  notes: string[]; // на что обратить внимание
  runnable: boolean; // есть что запускать (скрипт или статичный index.html)
  python: { requirements: boolean; framework: 'Flask' | 'FastAPI' | null; venv: boolean }; // Python-часть: ставим в свой venv
}

export function inspectProject(dir: string): Inspection {
  const r: Inspection = { stack: [], packageManager: null, hasLockfile: false, scripts: [], installScripts: [], depCount: 0, nodeEngine: null, envExample: null, envExists: false, envVars: [], notes: [], runnable: false, python: { requirements: false, framework: null, venv: false } };
  const has = (f: string) => existsSync(join(dir, f));

  const pj = join(dir, 'package.json');
  if (existsSync(pj)) {
    try {
      const j = JSON.parse(readFileSync(pj, 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } };
      r.stack.push('Node.js');
      r.scripts = Object.keys(j.scripts ?? {});
      r.installScripts = r.scripts.filter((s) => /^(pre|post)?install$|^prepare$/.test(s));
      const deps = { ...j.dependencies, ...j.devDependencies };
      r.depCount = Object.keys(deps).length;
      r.nodeEngine = j.engines?.node ?? null;
      for (const [name, label] of [['express', 'Express'], ['vite', 'Vite'], ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['fastify', 'Fastify'], ['telegraf', tr('Telegram-бот')], ['grammy', tr('Telegram-бот')]] as const) {
        if (deps[name] && !r.stack.includes(label)) r.stack.push(label);
      }
      r.runnable = r.scripts.includes('dev') || r.scripts.includes('start');
      if (!r.runnable) r.notes.push(tr('В package.json нет скрипта dev или start: сам не пойму, чем это запускать. Можно описать запуск в quorvox.json.'));
      if (r.installScripts.length) r.notes.push(tr('У проекта есть скрипты установки ({0}): при установке я их отключу, это защита от чужого кода.', r.installScripts.join(', ')));
    } catch {
      r.notes.push(tr('package.json не читается (ошибка в JSON).'));
    }
  }

  if (has('pnpm-lock.yaml')) (r.packageManager = 'pnpm'), (r.hasLockfile = true);
  else if (has('yarn.lock')) (r.packageManager = 'yarn'), (r.hasLockfile = true);
  else if (has('bun.lockb') || has('bun.lock')) (r.packageManager = 'bun'), (r.hasLockfile = true);
  else if (has('package-lock.json') || has('npm-shrinkwrap.json')) (r.packageManager = 'npm'), (r.hasLockfile = true);
  else if (existsSync(pj)) r.packageManager = 'npm';
  if (r.packageManager && !r.hasLockfile) r.notes.push(tr('Нет lock-файла: версии пакетов подтянутся свежие, а не те, на которых проект писали.'));

  const others: [string, string][] = [['requirements.txt', 'Python'], ['pyproject.toml', 'Python'], ['go.mod', 'Go'], ['Cargo.toml', 'Rust'], ['composer.json', 'PHP'], ['pom.xml', 'Java'], ['build.gradle', 'Java/Kotlin'], ['Gemfile', 'Ruby']];
  for (const [f, label] of others) if (has(f) && !r.stack.includes(label)) r.stack.push(label);
  // Python: Flask/FastAPI ставим в отдельный venv внутри проекта (системный Python не трогаем)
  if (has('requirements.txt')) {
    r.python.requirements = true;
    const reqs = readFileSync(join(dir, 'requirements.txt'), 'utf8').toLowerCase();
    if (/^\s*fastapi\b/m.test(reqs)) r.python.framework = 'FastAPI';
    else if (/^\s*flask\b/m.test(reqs)) r.python.framework = 'Flask';
    if (r.python.framework && !r.stack.includes(r.python.framework)) r.stack.push(r.python.framework);
  }
  r.python.venv = has('.venv') || has('venv');
  if (fromPython(dir, 'x')) r.runnable = true;
  const unsupported = r.stack.filter((s) => !/Node|Express|Vite|Next|React|Vue|Svelte|Fastify|Telegram|Flask|FastAPI/.test(s) && !(s === 'Python' && r.python.requirements));
  if (unsupported.length) r.notes.push(tr('Есть не-Node часть: зависимости для неё я не ставлю, это руками по README проекта.'));
  if (has('docker-compose.yml') || has('docker-compose.yaml') || has('Dockerfile')) r.notes.push(tr('Есть Docker: сам его не запускаю.'));

  if (!r.stack.length && has('index.html')) {
    r.stack.push(tr('Сайт (HTML/CSS/JS)'));
    r.runnable = true;
  } else if (!r.stack.length) r.notes.push(tr('Не понял, что это за проект: нет ни package.json, ни index.html.'));

  for (const f of ['.env.example', '.env.sample', '.env.template', 'example.env']) {
    if (has(f)) {
      r.envExample = f;
      break;
    }
  }
  r.envExists = has('.env');
  if (r.envExample) {
    // только имена переменных; значения из образца не читаем наружу
    for (const line of readFileSync(join(dir, r.envExample), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) r.envVars.push(m[1]);
    }
  }
  return r;
}

// установка зависимостей: ТОЛЬКО с отключёнными скриптами установки
export function installCommand(pm: NonNullable<Inspection['packageManager']>, hasLock: boolean): { cmd: string; args: string[] } {
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['install', '--ignore-scripts', ...(hasLock ? ['--frozen-lockfile'] : [])] };
    case 'yarn':
      return { cmd: 'yarn', args: ['install', '--ignore-scripts', ...(hasLock ? ['--frozen-lockfile'] : [])] };
    case 'bun':
      return { cmd: 'bun', args: ['install', '--ignore-scripts'] };
    default:
      return { cmd: 'npm', args: [hasLock ? 'ci' : 'install', '--ignore-scripts'] };
  }
}

export function runInstall(dir: string, pm: NonNullable<Inspection['packageManager']>, hasLock: boolean, onLine: (l: string) => void): Promise<number> {
  const { cmd, args } = installCommand(pm, hasLock);
  // на Windows менеджеры — .cmd-файлы, их без оболочки не запустить; аргументы у нас фиксированные, не от пользователя
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    const p = spawn(isWin ? `${cmd}.cmd` : cmd, args, { cwd: dir, shell: isWin, windowsHide: true });
    const t = setTimeout(() => p.kill(), 900_000);
    const feed = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => {
      clearTimeout(t);
      onLine(tr('не удалось запустить {0}: {1}', cmd, e.message));
      resolve(-1);
    });
    p.on('close', (c) => {
      clearTimeout(t);
      resolve(c ?? -1);
    });
  });
}

// .env из образца: только если .env ещё нет; значения не придумываем
export function createEnvFromExample(dir: string, example: string): boolean {
  const target = join(dir, '.env');
  if (existsSync(target)) return false;
  copyFileSync(join(dir, example), target);
  return true;
}

// Python: venv в папке проекта и установка только готовых пакетов (--only-binary): так не запускается чужой setup.py при установке
export async function installPython(dir: string, onLine: (l: string) => void): Promise<number> {
  const win = process.platform === 'win32';
  const sys = win ? 'python' : 'python3';
  if (!existsSync(join(dir, '.venv'))) {
    const c = await run(sys, ['-m', 'venv', '.venv'], dir, onLine);
    if (c !== 0) return c;
  }
  const py = win ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python');
  return run(py, ['-m', 'pip', 'install', '--only-binary=:all:', '-r', 'requirements.txt'], dir, onLine, 900_000);
}

// Честный отчёт без запуска: что найдут проверки и чего не хватает на этом компьютере
export interface Health {
  errors: number;
  warns: number;
  lines: string[];
}

export function healthReport(dir: string, ins: Inspection): Health {
  const rep = analyzeProject(dir, []);
  const bad = rep.findings.filter((f) => f.severity !== 'info');
  const lines = bad.slice(0, 8).map((f) => (f.severity === 'error' ? '✖ ' : '▲ ') + f.message + (f.file ? ' (' + f.file + (f.line ? ':' + f.line : '') + ')' : ''));
  const ver = (cmd: string) => {
    try {
      const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      return r.status === 0 ? (r.stdout || r.stderr).trim() : null;
    } catch {
      return null;
    }
  };
  if (ins.stack.some((x) => /Node|Express|Vite|Next|React|Vue|Svelte|Fastify|Telegram/.test(x))) {
    const v = ver('node');
    if (!v) lines.push('✖ ' + tr('Node.js не найден на этом компьютере: установи его с nodejs.org'));
    else if (ins.nodeEngine) {
      const need = /(\d+)/.exec(ins.nodeEngine)?.[1];
      const have = /v?(\d+)/.exec(v)?.[1];
      if (need && have && Number(have) < Number(need) && />=|\^|~/.test(ins.nodeEngine)) lines.push('▲ ' + tr('Проекту нужен Node {0}, а стоит {1}', ins.nodeEngine, v));
    }
  }
  if (ins.python.framework) {
    const v = ver(process.platform === 'win32' ? 'python' : 'python3');
    if (!v) lines.push('✖ ' + tr('Python не найден на этом компьютере: установи его с python.org'));
  }
  const errors = bad.filter((f) => f.severity === 'error').length + lines.filter((l) => l.startsWith('✖') && !bad.some((f) => l.includes(f.message))).length;
  return { errors, warns: bad.length - bad.filter((f) => f.severity === 'error').length, lines };
}
