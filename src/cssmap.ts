import type { Src } from './checks.ts';
import type { WebFile } from './webfiles.ts';

// Связка CSS с кодом: какие классы определены, какие нигде не используются,
// какие используются, но не определены (опечатки), и какой файл какими классами пользуется.
// Читаем только исходники, ничего не запускаем.

export interface CssClass {
  name: string;
  file: string;
  line: number;
  lib?: boolean; // класс ставит сторонняя библиотека (карта, доска, иконки), а не наш код
}

export interface CssStyleInfo {
  file: string;
  total: number;
  dead: CssClass[];
  usedBy: { file: string; count: number }[];
}

export interface CssTypo {
  name: string;
  like: string;
  file: string;
  line: number;
  dist: number; // сколько букв отличается от похожего класса
  strong: boolean; // класс вешают на элемент, а не переключают как флаг состояния
}

export interface CssReport {
  styles: CssStyleInfo[];
  typos: CssTypo[];
  externalCss: boolean;
  classes: CssClass[]; // все классы проекта (первое определение каждого): для подсказок в редакторе
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function lineOf(starts: number[], idx: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= idx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const blank = (m: string) => m.replace(/[^\n]/g, ' ');

// Классы, которые ставят библиотеки сами: по префиксу или по кастомному тегу в селекторе (cg-board, ...).
// В коде проекта их нет, и считать такие «мёртвыми» нельзя.
const LIB_PREFIX = /^(leaflet|pnlm|maplibregl|mapboxgl|mapillary|cg|swiper|slick|owl|tippy|flatpickr|select2|ql|ace|cm|hljs|katex|prism|toastify|noty|swal2|fa|bi|mdi)[-_]/i;
const CUSTOM_TAG = /(?:^|[\s>+~,(])[a-z][a-z0-9]*-[a-z0-9-]+(?![\w-])/;

// ---------- CSS: какие классы определены ----------

export function parseCssClasses(file: WebFile): CssClass[] {
  // комментарии, строки и url(...) затираем пробелами, но переносы оставляем, чтобы номера строк не поехали
  const s = file.src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, blank)
    .replace(/url\([^)]*\)/gi, blank);
  const starts = lineStarts(s);
  const out: CssClass[] = [];
  let begin = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      const prelude = s.slice(begin, i);
      // @media/@supports и т.п. сами правил не задают: их вложенные правила разберутся на следующих шагах
      if (!prelude.trimStart().startsWith('@')) {
        const found = [...prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)];
        // правило библиотечное, если в нём есть кастомный тег (cg-board) или класс с библиотечным префиксом (.cg-wrap .last-move)
        const libRule = CUSTOM_TAG.test(prelude.replace(/[.#][-\w]+/g, ' ')) || found.some((m) => LIB_PREFIX.test(m[1]));
        for (const m of found) {
          const lib = libRule;
          out.push({ name: m[1], file: file.rel, line: lineOf(starts, begin + m.index!), ...(lib ? { lib: true } : {}) });
        }
      }
      begin = i + 1;
    } else if (c === '}' || c === ';') {
      begin = i + 1;
    }
  }
  return out;
}

// ---------- код: какие классы используются ----------

function stripJsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\'"`\w])\/\/[^\n]*/g, (m, p: string) => p + ' '.repeat(m.length - p.length));
}

const TOKEN = /[A-Za-z_][\w-]*/g;
const LITERAL = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g;

// ${...} внутри шаблона — это код, а не классы
const noExpr = (s: string) => s.replace(/\$\{[^}]*\}/g, ' ');

function tokensOf(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

interface Usage {
  all: Set<string>; // все слова из строк (грубо: «где-то упомянут»)
  // слова из мест, где точно пишут классы → первая строка; strong — класс вешают на элемент
  // (class="...", className, classList.add), а не переключают как флаг состояния (toggle/contains)
  ctx: Map<string, { line: number; strong: boolean }>;
}

// слова из строковых литералов и из мест, где явно указывают классы
function usageOf(src: string, isHtml: boolean): Usage {
  const text = isHtml ? src : stripJsComments(src);
  const starts = lineStarts(text);
  const all = new Set<string>();
  const ctx = new Map<string, { line: number; strong: boolean }>();
  const addCtx = (raw: string, idx: number, strong = true) => {
    for (const t of tokensOf(noExpr(raw))) {
      all.add(t);
      const prev = ctx.get(t);
      if (!prev) ctx.set(t, { line: lineOf(starts, idx), strong });
      else if (strong && !prev.strong) prev.strong = true;
    }
  };

  if (!isHtml) {
    for (const m of text.matchAll(LITERAL)) for (const t of tokensOf(noExpr(m[1] ?? m[2] ?? m[3] ?? ''))) all.add(t);
  }
  // class="a b" в HTML и в HTML внутри строк JS (кавычки там бывают экранированы)
  for (const m of text.matchAll(/\bclass\s*=\s*\\?(["'])([^"'\\]*)\\?\1/g)) {
    addCtx(m[2], m.index!);
    if (isHtml) for (const t of tokensOf(noExpr(m[2]))) all.add(t);
  }
  if (!isHtml) {
    for (const m of text.matchAll(/\bclassList\s*\.\s*(add|remove|toggle|contains|replace)\s*\(([^)]*)\)/g)) {
      for (const l of m[2].matchAll(/(['"`])([^'"`]*)\1/g)) addCtx(l[2], m.index!, m[1] === 'add');
    }
    for (const m of text.matchAll(/\bclassName\s*(?:\+?=|:)\s*(['"`])([^'"`]*)\1/g)) addCtx(m[2], m.index!);
    for (const m of text.matchAll(/\bsetAttribute\(\s*['"]class['"]\s*,\s*(['"`])([^'"`]*)\1/g)) addCtx(m[2], m.index!);
  }
  return { all, ctx };
}

// ---------- опечатки ----------

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ---------- сборка ----------

export function analyzeCss(web: { html: WebFile[]; css: WebFile[] }, code: Src[]): CssReport {
  const empty: CssReport = { styles: [], typos: [], externalCss: false, classes: [] };
  if (!web.css.length) return empty;
  // CSS есть, а кода нет: оценивать «мёртвость» не с чем, но сами классы для подсказок отдаём
  if (!web.html.length && !code.length) {
    const only = new Map<string, CssClass>();
    for (const f of web.css) for (const c of parseCssClasses(f)) if (!only.has(c.name)) only.set(c.name, c);
    return { ...empty, classes: [...only.values()] };
  }

  const defined = new Map<string, CssClass>(); // имя → первое определение
  const perFile = new Map<string, Map<string, CssClass>>();
  for (const f of web.css) {
    const m = new Map<string, CssClass>();
    for (const c of parseCssClasses(f)) {
      const prev = m.get(c.name);
      // если хоть раз встретился в обычном правиле, класс считаем нашим, а не библиотечным
      if (!prev) m.set(c.name, c);
      else if (prev.lib && !c.lib) m.set(c.name, { ...c });
      if (!defined.has(c.name)) defined.set(c.name, c);
    }
    perFile.set(f.rel, m);
  }

  const usage = new Map<string, Usage>();
  for (const h of web.html) usage.set(h.rel, usageOf(h.src, true));
  for (const s of code) usage.set(s.rel, usageOf(s.src, false));

  const allTokens = new Set<string>();
  const prefixes = new Set<string>();
  for (const u of usage.values()) {
    for (const t of u.all) {
      allTokens.add(t);
      // `btn-${kind}` и `'tab-' + id` дают «btn-» и «tab-»: подходит любой класс с таким началом
      if (t.length >= 3 && (t.endsWith('-') || t.endsWith('_'))) prefixes.add(t);
    }
  }
  const isUsed = (name: string) => {
    if (allTokens.has(name)) return true;
    for (const p of prefixes) if (name.startsWith(p)) return true;
    // top1, top2, rank-3: номер приклеивают в коде ('top' + i), поэтому достаточно слова без цифр
    const numbered = /^(.+?)\d+$/.exec(name);
    return !!numbered && allTokens.has(numbered[1]);
  };

  const styles: CssStyleInfo[] = [];
  for (const [file, classes] of perFile) {
    const dead = [...classes.values()].filter((c) => !c.lib && !isUsed(c.name));
    const usedBy: { file: string; count: number }[] = [];
    for (const [f, u] of usage) {
      let n = 0;
      for (const name of classes.keys()) if (u.all.has(name)) n++;
      if (n) usedBy.push({ file: f, count: n });
    }
    usedBy.sort((a, b) => b.count - a.count);
    styles.push({ file, total: classes.size, dead, usedBy });
  }

  // опечатки: класс пишут в «классовых» местах, а в CSS его нет, зато есть очень похожий
  const typos: CssTypo[] = [];
  const names = [...defined.keys()];
  const seen = new Set<string>();
  for (const [file, u] of usage) {
    for (const [t, info] of u.ctx) {
      const line = info.line;
      if (seen.has(t) || defined.has(t) || t.length < 4 || /[-_]$/.test(t) || t.startsWith('js-')) continue;
      seen.add(t);
      const max = t.length <= 6 ? 1 : 2;
      let best: string | null = null;
      let bestD = max + 1;
      for (const n of names) {
        const d = distance(t, n, max);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best) typos.push({ name: t, like: best, file, line, dist: bestD, strong: info.strong });
    }
  }
  typos.sort((a, b) => a.name.localeCompare(b.name));

  const externalCss = web.html.some((h) => /<link\b[^>]*rel=["']?stylesheet[^>]*href=["']?https?:/i.test(h.src) || /<link\b[^>]*href=["']?https?:[^>]*rel=["']?stylesheet/i.test(h.src));
  return { styles, typos: typos.slice(0, 40), externalCss, classes: [...defined.values()] };
}
