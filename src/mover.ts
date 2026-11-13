import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve, basename, extname, sep } from 'node:path';
import { tr } from './i18n.ts';

// Безопасная перекладка файлов и папок: переносим и сразу чиним все ссылки на них.
// Работает с HTML (href/src/<style>), CSS (url, @import), JS/TS (import/require, path.join(__dirname, …),
// express.static) и сервером Express (если файл выпал из отдаваемой папки, добавляем отдачу новой).
// Сначала строится ПЛАН (ничего не меняется), потом он применяется или показывается на предпросмотр.

export interface MovePair {
  from: string;
  to: string;
}

export interface Edit {
  file: string; // путь файла ДО переноса
  start: number;
  end: number;
  oldText: string;
  newText: string;
  line: number;
  reason: string;
  kind: 'html' | 'css' | 'js' | 'server' | 'string';
}

export interface Insert {
  file: string;
  offset: number;
  text: string;
  line: number;
  reason: string;
}

export interface MovePlan {
  renames: { from: string; to: string; isDir: boolean }[];
  edits: Edit[];
  inserts: Insert[];
  warnings: string[]; // что нельзя починить автоматически
  mentions: { file: string; line: number; text: string }[]; // старый путь упоминается в тексте, который мы не правим
  errors: string[]; // с этим переносить нельзя
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor']);
const MAX_FILES = 20000;
const IMPLIED_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(abs);
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

const posix = (p: string) => p.split(sep).join('/');
const relPosix = (from: string, to: string) => posix(relative(from, to));
const blank = (m: string) => m.replace(/[^\n]/g, ' ');

function lineOfOffset(text: string, off: number): number {
  let n = 1;
  for (let i = 0; i < off && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// индекс закрывающей скобки для открывающей в позиции open (кавычки пропускаем)
function balanced(text: string, open: number): number {
  let depth = 0;
  let q = '';
  for (let i = open; i < text.length && i < open + 1500; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

// ---------- ссылки в файлах ----------

interface Ref {
  kind: 'html' | 'css' | 'js' | 'string';
  value: string;
  start: number;
}

function cssRefs(text: string, base = 0): Ref[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  const out: Ref[] = [];
  for (const m of t.matchAll(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi)) {
    out.push({ kind: 'css', value: m[2], start: base + m.index! + m[0].indexOf(m[2], 4) });
  }
  for (const m of t.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) {
    out.push({ kind: 'css', value: m[2], start: base + m.index! + m[0].indexOf(m[2], 7) });
  }
  return out;
}

function htmlRefs(text: string): Ref[] {
  const t = text.replace(/<!--[\s\S]*?-->/g, blank);
  const out: Ref[] = [];
  for (const m of t.matchAll(/<(?:a|link|script|img|source|video|audio|iframe|embed|track|object)\b[^>]*>/gi)) {
    for (const a of m[0].matchAll(/\b(?:href|src|poster|data)\s*=\s*(["'])([^"']*)\1/gi)) {
      if (!a[2]) continue;
      out.push({ kind: 'html', value: a[2], start: m.index! + a.index! + a[0].indexOf(a[2], a[0].indexOf('=')) });
    }
  }
  for (const s of t.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (s[1]) out.push(...cssRefs(s[1], s.index! + s[0].indexOf(s[1])));
  }
  return out;
}

function stripJsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\'"`\w])\/\/[^\n]*/g, (m, p: string) => p + ' '.repeat(m.length - p.length));
}

function jsRefs(text: string): Ref[] {
  const t = stripJsComments(text);
  const out: Ref[] = [];
  const specs = [
    /\bimport\s+(?:[^'"()]*?\s+from\s+)?(['"])(\.[^'"]+)\1/g,
    /\bexport\s+[^'"();]*?\s+from\s+(['"])(\.[^'"]+)\1/g,
    /\bimport\(\s*(['"])(\.[^'"]+)\1\s*\)/g,
    /\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/g,
  ];
  for (const re of specs) {
    for (const m of t.matchAll(re)) out.push({ kind: 'js', value: m[2], start: m.index! + m[0].lastIndexOf(m[2]) });
  }
  // строка-адрес файла целиком: '/css/style.css'
  for (const m of t.matchAll(/(['"`])(\/[A-Za-z0-9_.\/-]+\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|json|html?))\1/g)) {
    out.push({ kind: 'string', value: m[2], start: m.index! + 1 });
  }
  return out;
}

// ---------- какие папки отдаёт сервер ----------

interface WebRoot {
  dir: string;
  prefix: string; // '' или '/assets'
  serverFile?: string; // где объявлена отдача (Express)
  appVar?: string;
  insertAt?: number; // куда дописывать новую отдачу
  express: boolean;
}

function findWebRoots(root: string, files: string[], read: (f: string) => string): WebRoot[] {
  const roots: WebRoot[] = [];
  for (const f of files) {
    if (!/\.(m?js|cjs|ts)$/i.test(f)) continue;
    const text = read(f);
    if (!text.includes('express.static')) continue;
    for (const m of stripJsComments(text).matchAll(/([A-Za-z_$][\w$]*)\.use\(\s*(?:(['"`])(\/[^'"`]*)\2\s*,\s*)?express\.static\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = balanced(text, open);
      if (close < 0) continue;
      const arg = text.slice(open + 1, close);
      let dir: string | null = null;
      const pj = /^\s*path\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*(['"])[^'"]*\2)*)\s*\)/.exec(arg);
      if (pj) dir = resolve(dirname(f), ...[...pj[1].matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2]));
      else {
        const lit = /^\s*(['"`])([^'"`]+)\1/.exec(arg);
        if (lit) dir = resolve(root, lit[2]);
      }
      if (!dir) continue;
      // конец оператора: закрыли static(, потом use( и точка с запятой, дальше до конца строки
      let end = close + 1;
      const tail = /^\s*\)?\s*;?/.exec(text.slice(end));
      if (tail) end += tail[0].length;
      const nl = text.indexOf('\n', end);
      roots.push({ dir, prefix: (m[3] ?? '').replace(/\/+$/, ''), serverFile: f, appVar: m[1], insertAt: nl < 0 ? text.length : nl, express: true });
    }
  }
  if (roots.length) return roots;
  // без Express: типичные папки с сайтом или сам корень, если там index.html
  for (const name of ['public', 'static', 'www']) {
    const dir = join(root, name);
    if (existsSync(dir)) roots.push({ dir, prefix: '', express: false });
  }
  if (!roots.length && existsSync(join(root, 'index.html'))) roots.push({ dir: root, prefix: '', express: false });
  return roots;
}

// ---------- план ----------

export function planMove(root: string, pairsIn: MovePair[]): MovePlan {
  const plan: MovePlan = { renames: [], edits: [], inserts: [], warnings: [], mentions: [], errors: [] };
  root = resolve(root);
  const pairs = pairsIn.map((p) => ({ from: resolve(p.from), to: resolve(p.to) }));
  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

  // 1. можно ли вообще
  const seenTo = new Set<string>();
  for (const p of pairs) {
    if (!inside(p.from, root) || !inside(p.to, root)) plan.errors.push(tr('{0}: перенос только внутри проекта', basename(p.from)));
    else if (p.from === root) plan.errors.push(tr('Корень проекта переносить нельзя'));
    else if (!existsSync(p.from)) plan.errors.push(tr('{0}: такого файла или папки нет', relPosix(root, p.from)));
    else if (inside(p.to, p.from)) plan.errors.push(tr('{0}: нельзя положить внутрь самого себя', relPosix(root, p.from)));
    else if (existsSync(p.to)) plan.errors.push(tr('{0}: там уже что-то лежит, ничего не перезаписываю', relPosix(root, p.to)));
    else if (seenTo.has(p.to.toLowerCase())) plan.errors.push(tr('{0}: два файла просятся в одно место', relPosix(root, p.to)));
    seenTo.add(p.to.toLowerCase());
  }
  for (const a of pairs) for (const b of pairs) if (a !== b && inside(b.from, a.from)) plan.errors.push(tr('{0}: уже входит в переносимое {1}', relPosix(root, b.from), relPosix(root, a.from)));
  if (plan.errors.length) return plan;

  const files = listFiles(root);
  const cache = new Map<string, string>();
  const read = (f: string) => {
    let t = cache.get(f);
    if (t === undefined) {
      try {
        t = statSync(f).size > 1_500_000 ? '' : readFileSync(f, 'utf8');
      } catch {
        t = '';
      }
      cache.set(f, t);
    }
    return t;
  };

  // 2. что куда переезжает (по файлам)
  const map = new Map<string, string>();
  for (const p of pairs) {
    const isDir = statSync(p.from).isDirectory();
    plan.renames.push({ from: p.from, to: p.to, isDir });
    if (isDir) {
      for (const f of files) if (inside(f, p.from)) map.set(f, join(p.to, relative(p.from, f)));
    } else {
      map.set(p.from, p.to);
    }
  }

  const fileSet = new Set(files);
  const newPathOf = (abs: string): string => {
    const direct = map.get(abs);
    if (direct) return direct;
    for (const p of pairs) if (inside(abs, p.from)) return join(p.to, relative(p.from, abs));
    return abs;
  };

  const roots = findWebRoots(root, files, read).sort((a, b) => b.dir.length - a.dir.length);
  const urlFor = (abs: string): string | null => {
    for (const r of roots) if (inside(abs, r.dir) && abs !== r.dir) return r.prefix + '/' + relPosix(r.dir, abs);
    return null;
  };
  const fileForUrl = (url: string): string | null => {
    for (const r of roots) {
      if (r.prefix && !url.startsWith(r.prefix + '/')) continue;
      const cand = resolve(r.dir, '.' + url.slice(r.prefix.length));
      if (fileSet.has(cand)) return cand;
    }
    return null;
  };

  // отдача новых папок, которых сервер ещё не отдавал (создаём по одной на папку)
  const mounts = new Map<string, { prefix: string; folder: string }>();
  const expressRoot = roots.find((r) => r.express && r.serverFile);
  const mountFor = (newTarget: string): string | null => {
    if (!expressRoot) return null;
    const pair = pairs.find((p) => inside(newTarget, p.to));
    if (!pair) return null;
    const folder = statSync(pair.from).isDirectory() ? pair.to : dirname(pair.to);
    let m = mounts.get(folder);
    if (!m) {
      m = { prefix: '/' + basename(folder), folder };
      mounts.set(folder, m);
    }
    return m.prefix + '/' + relPosix(folder, newTarget);
  };

  const resolveImport = (from: string, spec: string): { target: string; implied: 'none' | 'ext' | 'index' } | null => {
    const base = resolve(dirname(from), spec);
    if (fileSet.has(base)) return { target: base, implied: 'none' };
    for (const e of IMPLIED_EXT) if (fileSet.has(base + e)) return { target: base + e, implied: 'ext' };
    for (const e of IMPLIED_EXT) if (fileSet.has(join(base, 'index' + e))) return { target: join(base, 'index' + e), implied: 'index' };
    return null;
  };

  const edited = new Set<string>(); // «файл:начало» — чтобы одну правку не делать дважды
  const addEdit = (file: string, text: string, r: { start: number; len: number }, newText: string, kind: Edit['kind'], reason: string) => {
    const key = `${file}:${r.start}`;
    if (edited.has(key)) return;
    edited.add(key);
    plan.edits.push({ file, start: r.start, end: r.start + r.len, oldText: text.slice(r.start, r.start + r.len), newText, line: lineOfOffset(text, r.start), reason, kind });
  };

  const rel = (p: string) => relPosix(root, p);

  // 3. ссылки внутри файлов
  for (const f of files) {
    if (!/\.(html?|css|m?js|cjs|ts|tsx|jsx)$/i.test(f)) continue;
    const text = read(f);
    if (!text) continue;
    const isHtml = /\.html?$/i.test(f);
    const isCss = /\.css$/i.test(f);
    const refs = isHtml ? htmlRefs(text) : isCss ? cssRefs(text) : jsRefs(text);
    const newFrom = newPathOf(f);

    for (const r of refs) {
      const m = /^([^?#]*)(.*)$/.exec(r.value)!;
      const path = m[1];
      if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(path)) continue;
      const rootRel = path.startsWith('/');
      let target: string | null = null;
      let implied: 'none' | 'ext' | 'index' = 'none';

      if (r.kind === 'js') {
        const res = resolveImport(f, path);
        if (!res) continue;
        target = res.target;
        implied = res.implied;
      } else if (rootRel) {
        target = fileForUrl(path);
      } else {
        const cand = resolve(dirname(f), path);
        if (fileSet.has(cand)) target = cand;
      }
      if (!target) continue;
      const newTarget = newPathOf(target);
      if (newTarget === target && newFrom === f) continue;

      let newPath: string;
      if (rootRel) {
        if (newTarget === target) continue; // адрес файла не изменился
        const url = urlFor(newTarget) ?? mountFor(newTarget);
        if (!url) {
          plan.warnings.push(tr('{0}:{1} ссылка {2}: новое место файла не отдаётся сервером, поправь вручную', rel(f), lineOfOffset(text, r.start), path));
          continue;
        }
        newPath = url;
      } else {
        let rp = relPosix(dirname(newFrom), newTarget);
        if (r.kind === 'js') {
          if (implied === 'ext') rp = rp.slice(0, rp.length - extname(rp).length);
          else if (implied === 'index') rp = rp.replace(/\/index\.[^/]+$/, '') || '.';
          if (!rp.startsWith('.')) rp = './' + rp;
        } else if (path.startsWith('./') && !rp.startsWith('.')) {
          rp = './' + rp;
        }
        newPath = rp;
      }
      if (newPath === path) continue;
      const what = rootRel || newTarget !== target ? tr('файл {0} переехал в {1}', rel(target), rel(newTarget)) : tr('этот файл переехал, путь к {0} пересчитан', rel(target));
      addEdit(f, text, { start: r.start, len: path.length }, newPath, r.kind === 'string' ? 'string' : r.kind, what);
    }

    // path.join(__dirname, …) в серверном коде и скриптах
    if (!isHtml && !isCss) {
      const t = stripJsComments(text);
      for (const m of t.matchAll(/path\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*(['"])[^'"]*\2)*)\s*\)/g)) {
        const segs = [...m[1].matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2]);
        const abs = resolve(dirname(f), ...segs);
        const newAbs = newPathOf(abs);
        if (newAbs === abs && newFrom === f) continue;
        const nsegs = relPosix(dirname(newFrom), newAbs).split('/').filter((s) => s && s !== '.');
        const q = /['"]/.exec(m[1])?.[0] ?? "'";
        const newArgs = nsegs.map((s) => `, ${q}${s}${q}`).join('');
        if (newArgs === m[1]) continue;
        const start = m.index! + m[0].indexOf('__dirname') + '__dirname'.length;
        addEdit(f, text, { start, len: m[1].length }, newArgs, 'server', tr('путь в коде: {0} теперь {1}', rel(abs), rel(newAbs)));
      }
      // express.static('public') — путь от корня проекта
      for (const m of t.matchAll(/express\.static\(\s*(['"`])([^'"`]+)\1/g)) {
        const abs = resolve(root, m[2]);
        const newAbs = newPathOf(abs);
        if (newAbs === abs) continue;
        const np = relPosix(root, newAbs);
        addEdit(f, text, { start: m.index! + m[0].lastIndexOf(m[2]), len: m[2].length }, np, 'server', tr('папка сайта переехала: {0} → {1}', rel(abs), rel(newAbs)));
      }
    }
  }

  // 4. отдача новых папок сервером (одной строкой после существующей)
  for (const m of mounts.values()) {
    const sf = expressRoot!.serverFile!;
    const stext = read(sf);
    const newSf = newPathOf(sf);
    const relFolder = relPosix(dirname(newSf), m.folder);
    const line = tr('\n{0}.use(\'{1}\', express.static(__dirname + \'/{2}\')); // добавлено Quorvox: папка переехала из отдаваемой сервером', expressRoot!.appVar, m.prefix, relFolder);
    plan.inserts.push({ file: sf, offset: expressRoot!.insertAt!, text: line, line: lineOfOffset(stext, expressRoot!.insertAt!) + 1, reason: tr('сервер должен отдавать новую папку {0} по адресу {1}', rel(m.folder), m.prefix) });
  }
  if (mounts.size === 0) {
    // файлы, которые отдавались, а теперь вне отдаваемых папок, но ссылок на них мы не нашли
    for (const [from, to] of map) {
      if (urlFor(from) && !urlFor(to) && !expressRoot) {
        plan.warnings.push(tr('{0} раньше открывался по адресу сайта, а {1} вне папки сайта: по ссылке он больше не откроется', rel(from), rel(to)));
        break;
      }
    }
  }

  // 5. упоминания старого пути там, где мы не правим (конфиги, скрипты, документация)
  const needles = pairs.map((p) => rel(p.from)).filter((n) => n.includes('/') || n.includes('.'));
  const editedFiles = new Set(plan.edits.map((e) => e.file));
  for (const f of files) {
    if (editedFiles.has(f) || /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|webm|mp3|zip|pdf)$/i.test(f)) continue;
    if (basename(f) === 'package-lock.json' || plan.mentions.length >= 30) continue;
    const text = read(f);
    if (!text) continue;
    for (const n of needles) {
      const i = text.search(new RegExp(`(?<![\\w./-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`));
      if (i >= 0) {
        const line = lineOfOffset(text, i);
        plan.mentions.push({ file: rel(f), line, text: text.split('\n')[line - 1].trim().slice(0, 140) });
        break;
      }
    }
  }

  plan.edits.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  return plan;
}

// ---------- применение на диск и откат (без VS Code: для тестов и надёжного отката) ----------

// На Windows папку иногда на миг держат наблюдатели файлов (VS Code, антивирус): ждём и пробуем ещё
export function renameRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 12 || !(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

export interface Snapshot {
  texts: Record<string, string>; // исходный текст всех правленных файлов (путь ДО переноса)
  renames: { from: string; to: string }[];
}

export function makeSnapshot(plan: MovePlan): Snapshot {
  const texts: Record<string, string> = {};
  for (const f of new Set([...plan.edits.map((e) => e.file), ...plan.inserts.map((i) => i.file)])) texts[f] = readFileSync(f, 'utf8');
  return { texts, renames: plan.renames.map((r) => ({ from: r.from, to: r.to })) };
}

export function applyToDisk(plan: MovePlan): { changedFiles: number } {
  const byFile = new Map<string, { edits: Edit[]; inserts: Insert[] }>();
  for (const e of plan.edits) byFile.set(e.file, { edits: [...(byFile.get(e.file)?.edits ?? []), e], inserts: byFile.get(e.file)?.inserts ?? [] });
  for (const i of plan.inserts) byFile.set(i.file, { edits: byFile.get(i.file)?.edits ?? [], inserts: [...(byFile.get(i.file)?.inserts ?? []), i] });
  for (const [file, { edits, inserts }] of byFile) {
    let text = readFileSync(file, 'utf8');
    // правим с конца, чтобы смещения не поехали
    const all = [
      ...edits.map((e) => ({ at: e.start, end: e.end, old: e.oldText, text: e.newText })),
      ...inserts.map((i) => ({ at: i.offset, end: i.offset, old: '', text: i.text })),
    ].sort((a, b) => b.at - a.at);
    for (const x of all) {
      if (text.slice(x.at, x.end) !== x.old) throw new Error(tr('{0}: файл изменился после подготовки плана, повтори', file));
      text = text.slice(0, x.at) + x.text + text.slice(x.end);
    }
    writeFileSync(file, text, 'utf8');
  }
  for (const r of plan.renames) {
    mkdirSync(dirname(r.to), { recursive: true });
    renameRetry(r.from, r.to);
  }
  return { changedFiles: byFile.size };
}

// вернуть всё как было: переносы обратно, потом исходный текст файлов
export function undoSnapshot(snap: Snapshot): { restored: number } {
  for (const r of [...snap.renames].reverse()) {
    if (existsSync(r.to) && !existsSync(r.from)) {
      mkdirSync(dirname(r.from), { recursive: true });
      renameRetry(r.to, r.from);
    }
  }
  let restored = 0;
  for (const [file, text] of Object.entries(snap.texts)) {
    if (existsSync(file)) {
      writeFileSync(file, text, 'utf8');
      restored++;
    }
  }
  return { restored };
}

