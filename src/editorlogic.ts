import type { EditorIndex } from './checks.ts';

// Логика подсказок в редакторе без VS Code: по тексту строки и позиции курсора понимаем,
// что человек набирает (класс, адрес API, переменную окружения), и что ему предложить.

// ---------- что набирается слева от курсора ----------

export interface ClassCtx {
  prefix: string; // уже набранная часть имени класса
}

// Внутри class="…", className = '…', classList.add('…'), а также после точки в querySelector('.…')
export function classContext(before: string): ClassCtx | null {
  const lastToken = (value: string) => /[^\s]*$/.exec(value)![0];
  let m = /\bclass\s*=\s*\\?(["'])([^"'\\]*)$/.exec(before);
  if (m) return { prefix: lastToken(m[2]) };
  m = /\bclassName\s*(?:\+?=|:)\s*(["'`])([^"'`]*)$/.exec(before);
  if (m) return { prefix: lastToken(m[2]) };
  m = /\bclassList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\((?:[^()]*,\s*)?(["'`])([^"'`]*)$/.exec(before);
  if (m) return { prefix: lastToken(m[2]) };
  m = /\b(?:querySelector(?:All)?|closest|matches)\s*\(\s*(["'`])([^"'`]*)$/.exec(before);
  if (m) {
    const tok = /[.#]?[\w-]*$/.exec(m[2])![0];
    if (tok.startsWith('.')) return { prefix: tok.slice(1) };
  }
  return null;
}

export interface ApiCtx {
  kind: 'api' | 'fetch';
  typed: string; // что уже набрано внутри кавычек (путь)
  quote: string;
}

export function apiContext(before: string): ApiCtx | null {
  let m = /\bapi\s*\(\s*(['"`])([^'"`?#]*)$/.exec(before);
  if (m) return { kind: 'api', typed: m[2], quote: m[1] };
  m = /\bfetch\s*\(\s*(['"`])(\/[^'"`?#]*)$/.exec(before);
  if (m) return { kind: 'fetch', typed: m[2], quote: m[1] };
  return null;
}

export function envContext(before: string): { prefix: string } | null {
  const m = /process\.env\.([A-Za-z0-9_]*)$/.exec(before);
  return m ? { prefix: m[1] } : null;
}

// ---------- что предложить ----------

export interface RouteItem {
  path: string; // что вставить (для api() — без префикса /api)
  methods: string[];
  file: string;
  line: number;
}

// Адреса сервера для подсказки. Для api('/') префикс /api уже внутри помощника, поэтому отрезаем его
export function routeItems(index: EditorIndex, ctx: ApiCtx): RouteItem[] {
  const prefix = ctx.kind === 'api' ? index.apiPrefix.replace(/\/+$/, '') : '';
  const byPath = new Map<string, RouteItem>();
  for (const r of index.routes) {
    let p = r.full;
    if (prefix) {
      if (p !== prefix && !p.startsWith(prefix + '/')) continue;
      p = p.slice(prefix.length) || '/';
    }
    const have = byPath.get(p);
    if (have) {
      if (!have.methods.includes(r.method)) have.methods.push(r.method);
    } else {
      byPath.set(p, { path: p, methods: [r.method], file: r.file, line: r.line });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// :id → ${id}, если строка в обратных кавычках (там можно подставлять значения)
export function insertPath(item: RouteItem, quote: string): string {
  return quote === '`' ? item.path.replace(/:([A-Za-z_]\w*)/g, '${$1}') : item.path;
}

// ---------- слово под курсором ----------

const WORD = /[\w-]/;

function wordAt(line: string, col: number): { text: string; start: number; end: number } | null {
  let s = col;
  let e = col;
  while (s > 0 && WORD.test(line[s - 1])) s--;
  while (e < line.length && WORD.test(line[e])) e++;
  return s === e ? null : { text: line.slice(s, e), start: s, end: e };
}

// имя класса под курсором, если курсор в «классовом» месте
export function classAtCursor(line: string, col: number): { name: string; start: number; end: number } | null {
  const w = wordAt(line, col);
  if (!w) return null;
  return classContext(line.slice(0, w.start)) ? { name: w.text, start: w.start, end: w.end } : null;
}

export function envAtCursor(line: string, col: number): { name: string; start: number; end: number } | null {
  for (const m of line.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (col >= start && col <= end) return { name: (m[1] ?? m[2])!, start, end };
  }
  return null;
}

// строка с адресом внутри api('…') / fetch('…') под курсором
export function apiPathAtCursor(line: string, col: number): { kind: 'api' | 'fetch'; path: string } | null {
  for (const m of line.matchAll(/\b(api|fetch)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\\n])*)\2/g)) {
    const contentStart = m.index! + m[0].indexOf(m[2]) + 1;
    const contentEnd = contentStart + m[3].length;
    if (col < contentStart || col > contentEnd) continue;
    const path = m[3].split(/[?#]/)[0];
    if (m[1] === 'api' ? path.startsWith('/') : path.startsWith('/')) return { kind: m[1] as 'api' | 'fetch', path };
  }
  return null;
}

// какие маршруты подходят под набранный путь (${x} и :id — любое значение)
export function routesForPath(index: EditorIndex, ctx: { kind: 'api' | 'fetch'; path: string }) {
  const full = ((ctx.kind === 'api' ? index.apiPrefix : '') + ctx.path).replace(/\/{2,}/g, '/');
  const segs = full.split('/').filter(Boolean);
  return index.routes.filter((r) => {
    const rs = r.full.split('/').filter(Boolean);
    if (rs.length !== segs.length) return false;
    return segs.every((s, i) => s.includes('${') || s.startsWith(':') || rs[i].startsWith(':') || rs[i] === s);
  });
}

// ---------- кусок CSS для подсказки ----------

// от строки определения до закрывающей скобки (не больше maxLines строк)
export function cssRuleAt(cssText: string, line: number, maxLines = 14): string {
  const lines = cssText.split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = Math.max(0, line - 1); i < lines.length && out.length < maxLines; i++) {
    const l = lines[i];
    out.push(l);
    for (const ch of l) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) break;
  }
  return out.join('\n');
}
