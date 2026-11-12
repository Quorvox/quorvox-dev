import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { SKIP_DIRS, collectWeb } from './webfiles.ts';
import type { WebFile } from './webfiles.ts';
import { analyzeCss } from './cssmap.ts';
import type { CssReport } from './cssmap.ts';
import { checkLinks } from './links.ts';

// Локальные проверки проекта (Node/Express + fetch/api во фронте + .env).
// Без запуска кода и без сети: просто читаем исходники регулярками.

export interface Finding {
  kind: 'route' | 'method' | 'env' | 'port' | 'css' | 'link';
  severity: 'error' | 'warn' | 'info';
  message: string;
  file?: string;
  line?: number;
}

export interface ServiceInfo {
  name: string;
  cwd: string;
}

// то, что нужно редактору для подсказок: что есть в проекте
export interface EditorIndex {
  classes: { name: string; file: string; line: number }[]; // классы из CSS
  routes: { method: string; full: string; file: string; line: number }[]; // адреса сервера
  apiPrefix: string; // с чем уходит api('/путь'), например /api
  env: { name: string; defined: boolean; required: boolean; file: string; line: number }[];
}

export interface Report {
  findings: Finding[];
  stats: { files: number; routes: number; calls: number; unresolvedRouters: string[] };
  index: EditorIndex;
}

// текст несохранённых файлов: ключ — абсолютный путь в нижнем регистре
export type Overrides = Map<string, string>;

const MAX_FILES = 4000;
const MAX_SIZE = 600_000;
const NOT_ROUTERS = new Set(['req', 'res', 'headers', 'cache', 'map', 'params', 'searchParams', 'store', 'Map', 'url', 'URLSearchParams']);
const ANY = '\u0001'; // место подстановки ${...}

export interface Src {
  abs: string;
  rel: string;
  src: string;
  server: boolean;
  starts: number[];
}

export interface Route {
  method: string;
  full: string;
  segs: string[];
  file: string;
  line: number;
}

export function lineAt(f: Src, idx: number): number {
  let lo = 0;
  let hi = f.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f.starts[mid] <= idx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function collect(root: string, overrides?: Overrides): Src[] {
  const out: Src[] = [];
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
        continue;
      }
      if (!/\.(m?js|cjs|ts)$/.test(e.name) || e.name.endsWith('.d.ts') || /\.min\./.test(e.name)) continue;
      try {
        if (statSync(abs).size > MAX_SIZE) continue;
        // если файл открыт и не сохранён, берём то, что набрано в редакторе
        const src = overrides?.get(abs.toLowerCase()) ?? readFileSync(abs, 'utf8');
        const rel = relative(root, abs).replace(/\\/g, '/');
        const server =
          /^server\//.test(rel) ||
          /require\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/.test(src) ||
          /\bRouter\s*\(/.test(src);
        const starts = [0];
        for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
        out.push({ abs, rel, src, server, starts });
      } catch {
        // нечитаемый файл — пропускаем
      }
    }
  }
  return out;
}

function norm(p: string): string {
  const s = ('/' + p).replace(/\/{2,}/g, '/');
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

function segsOf(p: string): string[] {
  return p.split('/').filter(Boolean);
}

// ---------- маршруты ----------

function requireVars(f: Src): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of f.src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*(['"])(\.[^'"]+)\2\s*\)/g)) vars.set(m[1], m[3]);
  for (const m of f.src.matchAll(/\bimport\s+(\w+)\s+from\s+(['"])(\.[^'"]+)\2/g)) vars.set(m[1], m[3]);
  for (const m of f.src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])(\.[^'"]+)\2\s*\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop()!.trim();
      if (name) vars.set(name, m[3]);
    }
  }
  return vars;
}

export function resolveModule(from: Src, spec: string, byAbs: Map<string, Src>): Src | null {
  const base = resolve(dirname(from.abs), spec);
  for (const cand of [base, base + '.js', base + '.cjs', base + '.mjs', base + '.ts', join(base, 'index.js')]) {
    const hit = byAbs.get(cand.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

interface Edge {
  from: Src;
  to: Src;
  path: string;
}

function findEdges(servers: Src[], byAbs: Map<string, Src>): Edge[] {
  const edges: Edge[] = [];
  for (const f of servers) {
    const vars = requireVars(f);
    const pick = (expr: string): Src | null => {
      const e = expr.trimStart();
      if (/^(\(|async\b|function\b|express\.|cors\b)/.test(e)) return null;
      for (const c of e.matchAll(/require\(\s*(['"])(\.[^'"]+)\1\s*\)|\b([A-Za-z_$][\w$]*)\b/g)) {
        const spec = c[2] ?? (c[3] && vars.get(c[3]));
        if (!spec) continue;
        const hit = resolveModule(f, spec, byAbs);
        if (hit) return hit;
      }
      return null;
    };
    for (const m of f.src.matchAll(/\.use\(\s*(['"`])(\/[^'"`]*)\1\s*,/g)) {
      const end = f.src.indexOf(';', m.index! + m[0].length);
      const expr = f.src.slice(m.index! + m[0].length, end < 0 ? undefined : Math.min(end, m.index! + 400));
      const to = pick(expr);
      if (to && to !== f) edges.push({ from: f, to, path: m[2] });
    }
    for (const m of f.src.matchAll(/\.use\(\s*([A-Za-z_$][\w$]*)\s*[),]/g)) {
      const spec = vars.get(m[1]);
      const to = spec && resolveModule(f, spec, byAbs);
      if (to && to !== f && /\bRouter\s*\(/.test(to.src)) edges.push({ from: f, to, path: '' });
    }
  }
  return edges;
}

function findRoutes(servers: Src[], byAbs: Map<string, Src>): { routes: Route[]; unresolved: string[] } {
  const prefixes = new Map<Src, Set<string>>();
  // файл-приложение (express() / не роутер) живёт в корне
  for (const f of servers) {
    if (/\bexpress\(\s*\)/.test(f.src) || !/\bRouter\s*\(/.test(f.src)) prefixes.set(f, new Set(['']));
  }
  const edges = findEdges(servers, byAbs);
  let changed = true;
  for (let guard = 0; changed && guard < 10; guard++) {
    changed = false;
    for (const e of edges) {
      const fp = prefixes.get(e.from);
      if (!fp) continue;
      for (const p of fp) {
        const np = norm(p + '/' + e.path);
        const set = prefixes.get(e.to) ?? new Set<string>();
        if (!set.has(np === '/' ? '' : np)) {
          set.add(np === '/' ? '' : np);
          prefixes.set(e.to, set);
          changed = true;
        }
      }
    }
  }

  const routes: Route[] = [];
  const unresolved: string[] = [];
  for (const f of servers) {
    const own = [...f.src.matchAll(/\b(\w+)\.(get|post|put|patch|delete|all)\(\s*(['"`])(\/[^'"`]*)\3/g)].filter(
      (m) => !NOT_ROUTERS.has(m[1]),
    );
    if (!own.length) continue;
    const pf = prefixes.get(f);
    if (!pf) {
      unresolved.push(f.rel);
      continue;
    }
    for (const m of own) {
      for (const p of pf) {
        const full = norm(p + '/' + m[4]);
        routes.push({ method: m[2].toUpperCase(), full, segs: segsOf(full), file: f.rel, line: lineAt(f, m.index!) });
      }
    }
  }
  return { routes, unresolved };
}

// ---------- запросы фронта ----------

export interface Call {
  method: string | null; // null — метод задан непонятно (переменной), не проверяем
  segs: string[];
  tail: boolean; // дальше путь продолжается (конкатенация) — длина неизвестна
  partial: boolean; // последний сегмент недописан
  text: string;
  file: string;
  line: number;
}

// закрывающая скобка вызова — чтобы найти { method: 'POST' } внутри этого же вызова
function callWindow(src: string, open: number): string {
  let depth = 0;
  let q = '';
  for (let i = open; i < Math.min(src.length, open + 700); i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open, open + 700);
}

// как во фронте вызывается api(): с каким префиксом уходит запрос
function apiPrefix(client: Src[]): { byFile: Map<Src, string>; global: string } {
  const per = new Map<Src, string>();
  let global: string | null = null;
  for (const f of client) {
    const def = /\b(?:function\s+api\b|(?:const|let|var)\s+api\s*=)/.exec(f.src);
    if (!def) continue;
    const body = f.src.slice(def.index, def.index + 500);
    const pre = /fetch\(\s*(['"`])(\/[^'"`$]*)\1\s*\+/.exec(body);
    const val = pre ? pre[2] : '';
    per.set(f, val);
    if (global === null || /util|api|http/.test(f.rel)) global = val;
  }
  const out = new Map<Src, string>();
  for (const f of client) out.set(f, per.get(f) ?? global ?? '/api');
  return { byFile: out, global: global ?? '/api' };
}

function findCalls(client: Src[], prefixes: Map<Src, string>): Call[] {
  const calls: Call[] = [];
  for (const f of client) {
    for (const m of f.src.matchAll(/\b(api|fetch)\(\s*(['"`])((?:\\.|(?!\2)[^\\\n])*)\2/g)) {
      let body = m[3];
      let path: string;
      if (m[1] === 'api') {
        if (!body.startsWith('/')) continue;
        path = (prefixes.get(f)! + body).replace(/\/{2,}/g, '/');
      } else {
        if (!/^\/api(\/|\?|$|\$)/.test(body)) continue;
        path = body;
      }
      body = path;
      const after = f.src.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
      const tail = /^\s*\+/.test(after);
      // fetch('/api' + path) — это само определение помощника api(), а не запрос
      if (m[1] === 'fetch' && body === '/api' && tail) continue;
      let clean = body.replace(/\$\{[^}]*\}/g, ANY);
      const q = clean.search(/[?#]/);
      const hasQuery = q >= 0;
      if (hasQuery) clean = clean.slice(0, q);
      const trailingSlash = clean.endsWith('/');
      const win = callWindow(f.src, m.index! + m[1].length);
      const lit = /\bmethod\s*:\s*(['"`])(\w+)\1/i.exec(win);
      const method = lit ? lit[2].toUpperCase() : /\bmethod\b/.test(win) ? null : 'GET';
      const segs = segsOf(clean);
      const dynTail = tail && !hasQuery;
      calls.push({
        method,
        segs,
        tail: dynTail,
        partial: dynTail && !trailingSlash,
        text: body.replace(/\$\{[^}]*\}/g, ':x'),
        file: f.rel,
        line: lineAt(f, m.index!),
      });
    }
  }
  return calls;
}

function segMatch(rseg: string, cseg: string, partial: boolean): boolean {
  if (cseg.includes(ANY)) return true;
  if (rseg.startsWith(':') || rseg === '*') return true;
  return partial ? rseg.startsWith(cseg) : rseg === cseg;
}

export function matches(c: Call, r: Route): boolean {
  const n = c.segs.length;
  if (!c.tail) return r.segs.length === n && c.segs.every((s, i) => segMatch(r.segs[i], s, false));
  const need = c.partial ? n : n + 1;
  if (r.segs.length < need) return false;
  return c.segs.every((s, i) => segMatch(r.segs[i], s, c.partial && i === n - 1));
}

// ---------- переменные окружения ----------

function parseEnvKeys(file: string): string[] {
  try {
    return [...readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

function findEnvFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen++ < 2000) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') stack.push(join(dir, e.name));
      } else if (/^\.env(\.|$)|\.env(\.\w+)?$/.test(e.name)) out.push(join(dir, e.name));
    }
  }
  return out;
}

export interface EnvUse {
  file: string;
  line: number;
  required: boolean; // используется без запасного значения
}

// какие переменные окружения читает серверный код и где
export function envUsage(servers: Src[]): Map<string, EnvUse> {
  const used = new Map<string, EnvUse>();
  for (const f of servers) {
    for (const m of f.src.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g)) {
      const name = (m[1] ?? m[2])!;
      const before = f.src.slice(Math.max(0, m.index! - 14), m.index!);
      const after = f.src.slice(m.index! + m[0].length, m.index! + m[0].length + 8);
      // с запасным значением или проверкой «есть ли вообще» — не обязательная
      const optional = /(\|\||\?\?|&&|\?|===|!==|==|!=|\))/.test(after.trimStart().slice(0, 3)) || /(if\s*\(|!|&&|\|\||\?)\s*$/.test(before);
      const prev = used.get(name);
      if (!prev || (!optional && !prev.required)) used.set(name, { file: f.rel, line: lineAt(f, m.index!), required: !optional });
    }
  }
  return used;
}

function checkEnv(root: string, servers: Src[]): Finding[] {
  const used = envUsage(servers);
  if (!used.size) return [];

  const envFiles = findEnvFiles(root);
  if (!envFiles.length) {
    return [
      {
        kind: 'env',
        severity: 'info',
        message: `В коде ${used.size} переменных окружения, но нет ни .env, ни .env.example — новичку не понятно, что задавать`,
      },
    ];
  }
  const defined = new Set(envFiles.flatMap(parseEnvKeys));
  const out: Finding[] = [];
  for (const [name, u] of used) {
    if (u.required && !defined.has(name)) {
      out.push({
        kind: 'env',
        severity: 'warn',
        message: `${name}: используется без запасного значения, но не описана ни в одном .env`,
        file: u.file,
        line: u.line,
      });
    }
  }
  return out;
}

// ---------- порты ----------

function servicePort(cwd: string): number | null {
  for (const name of ['.env', '.env.local', '.env.development']) {
    const p = join(cwd, name);
    if (existsSync(p)) {
      const m = /^\s*PORT\s*=\s*(\d+)/m.exec(readFileSync(p, 'utf8'));
      if (m) return Number(m[1]);
    }
  }
  const entry = ['server/index.js', 'index.js', 'src/server.js', 'server.js', 'src/index.js', 'app.js']
    .map((x) => join(cwd, x))
    .find((x) => existsSync(x));
  if (!entry) return null;
  const src = readFileSync(entry, 'utf8');
  const m = /process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/.exec(src) ?? /\.listen\(\s*(\d{2,5})\b/.exec(src);
  return m ? Number(m[1]) : null;
}

function checkPorts(services: ServiceInfo[]): Finding[] {
  const byPort = new Map<number, string[]>();
  for (const s of services) {
    const p = servicePort(s.cwd);
    if (p) byPort.set(p, [...(byPort.get(p) ?? []), s.name]);
  }
  const out: Finding[] = [];
  for (const [port, names] of byPort) {
    if (names.length > 1) {
      out.push({ kind: 'port', severity: 'error', message: `Порт ${port} занят сразу у нескольких сервисов: ${names.join(', ')} — второй не запустится` });
    }
  }
  return out;
}

// ---------- CSS ----------

function checkCss(css: CssReport): Finding[] {
  const out: Finding[] = [];
  for (const t of css.typos) {
    // вероятная опечатка — разница в одну букву у не слишком короткого слова, остальное «возможно»
    const likely = t.strong && t.dist <= 1 && t.name.length >= 5;
    out.push({
      kind: 'css',
      severity: likely ? 'warn' : 'info',
      message: `Класс .${t.name} используется в коде, но в CSS его нет (возможно, опечатка: .${t.like})`,
      file: t.file,
      line: t.line,
    });
  }
  for (const s of css.styles) {
    if (s.dead.length < 3) continue;
    const names = s.dead.slice(0, 4).map((c) => '.' + c.name).join(', ');
    out.push({
      kind: 'css',
      severity: 'info',
      message: `${s.file}: ${s.dead.length} из ${s.total} классов, похоже, нигде не используются (${names}${s.dead.length > 4 ? '…' : ''})`,
      file: s.file,
      line: s.dead[0].line,
    });
  }
  return out;
}

// ---------- сборка отчёта ----------

// общий разбор проекта: им пользуются и проверки, и карта
export interface Scan {
  files: Src[];
  byAbs: Map<string, Src>;
  servers: Src[];
  client: Src[];
  routes: Route[];
  calls: Call[];
  unresolved: string[];
  apiPrefix: string;
}

export function scanProject(root: string, overrides?: Overrides): Scan {
  const files = collect(root, overrides);
  const byAbs = new Map(files.map((f) => [f.abs.toLowerCase(), f]));
  const servers = files.filter((f) => f.server);
  const client = files.filter((f) => !f.server);
  const { routes, unresolved } = findRoutes(servers, byAbs);
  const prefixes = apiPrefix(client);
  const calls = findCalls(client, prefixes.byFile);
  return { files, byAbs, servers, client, routes, calls, unresolved, apiPrefix: prefixes.global };
}

// какие переменные окружения читает код и описаны ли они в .env-файлах
function envIndex(root: string, servers: Src[]): EditorIndex['env'] {
  const used = envUsage(servers);
  if (!used.size) return [];
  const defined = new Set(findEnvFiles(root).flatMap(parseEnvKeys));
  return [...used].map(([name, u]) => ({ name, defined: defined.has(name), required: u.required, file: u.file, line: u.line }));
}

export function analyzeProject(root: string, services: ServiceInfo[] = [], overrides?: Overrides): Report {
  const { files, servers, routes, calls, unresolved, apiPrefix: prefix } = scanProject(root, overrides);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (f: Finding) => {
    const key = `${f.kind}|${f.message}|${f.file}|${f.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(f);
    }
  };

  if (routes.length) {
    for (const c of calls) {
      const hits = routes.filter((r) => matches(c, r));
      const label = `/${c.segs.join('/')}${c.tail ? '/…' : ''}`.replace(ANY, ':x');
      if (!hits.length) {
        add({
          kind: 'route',
          severity: unresolved.length ? 'info' : 'warn',
          message: `Фронт зовёт ${label}, а такого маршрута на сервере не нашёл` + (unresolved.length ? ' (часть роутеров не удалось разобрать)' : ''),
          file: c.file,
          line: c.line,
        });
      } else if (c.method && !hits.some((r) => r.method === 'ALL' || r.method === c.method)) {
        add({
          kind: 'method',
          severity: 'error',
          message: `Фронт зовёт ${c.method} ${label}, а на сервере этот маршрут только для ${[...new Set(hits.map((r) => r.method))].join('/')}`,
          file: c.file,
          line: c.line,
        });
      }
    }
  }
  for (const f of checkEnv(root, servers)) add(f);
  for (const f of checkPorts(services)) add(f);
  const web = collectWeb(root, overrides);
  const css = analyzeCss(web, files);
  for (const f of checkCss(css)) add(f);
  for (const f of checkLinks(root, web, servers.length > 0)) add(f);

  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    findings,
    stats: { files: files.length, routes: routes.length, calls: calls.length, unresolvedRouters: unresolved },
    index: {
      classes: css.classes.map((c) => ({ name: c.name, file: c.file, line: c.line })),
      routes: routes.map((r) => ({ method: r.method, full: r.full, file: r.file, line: r.line })),
      apiPrefix: prefix,
      env: envIndex(root, servers),
    },
  };
}
