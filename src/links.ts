import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import type { Finding } from './checks.ts';
import type { WebFile } from './webfiles.ts';
import { tr } from './i18n.ts';

// Битые ссылки на файлы: картинки, стили, скрипты, шрифты и страницы, на которые указывают HTML и CSS.
// Отдельно ловим разницу в регистре: на Windows работает, на сервере с Linux файл не найдётся.

// проверяем только то, что похоже на файл (с расширением): адреса маршрутов сервера не трогаем
const CHECK_EXT = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|html?|json|pdf|mp4|webm|mp3|wav|webmanifest)$/i;
const SKIP_REF = /^(#|mailto:|tel:|javascript:|data:|blob:|about:|sms:|whatsapp:|tg:|[a-z][a-z0-9+.-]*:\/\/|\/\/)/i;
const DYNAMIC = /\{\{|\}\}|\$\{|<%|%>|\{%|<\?/;

const blank = (m: string) => m.replace(/[^\n]/g, ' ');

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

function tagAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

interface Ref {
  ref: string;
  line: number;
}

function refsOf(file: WebFile, isCss: boolean): Ref[] {
  const out: Ref[] = [];
  if (isCss) {
    const text = file.src.replace(/\/\*[\s\S]*?\*\//g, blank);
    const starts = lineStarts(text);
    for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+?)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi)) out.push({ ref: (m[2] ?? m[4])!, line: lineOf(starts, m.index!) });
    return out;
  }
  const text = file.src.replace(/<!--[\s\S]*?-->/g, blank);
  const starts = lineStarts(text);
  for (const m of text.matchAll(/<(?:a|link|script|img|source|video|audio|iframe|embed|track|object)\b[^>]*>/gi)) {
    for (const attr of ['href', 'src', 'poster', 'data']) {
      const v = tagAttr(m[0], attr);
      if (v) out.push({ ref: v, line: lineOf(starts, m.index!) });
    }
  }
  return out;
}

// ссылка → путь, который стоит проверять (или null, если это не про нас)
function clean(ref: string): string | null {
  let r = ref.trim();
  if (!r || SKIP_REF.test(r) || DYNAMIC.test(r)) return null;
  r = r.split(/[?#]/)[0];
  try {
    r = decodeURI(r);
  } catch {
    // оставляем как есть
  }
  return CHECK_EXT.test(r) ? r : null;
}

type Found = { kind: 'ok' } | { kind: 'case'; actual: string } | { kind: 'missing' };

export function checkLinks(root: string, web: { html: WebFile[]; css: WebFile[] }, hasServer: boolean): Finding[] {
  const dirCache = new Map<string, string[]>();
  const ls = (dir: string): string[] => {
    let v = dirCache.get(dir);
    if (!v) {
      try {
        v = readdirSync(dir);
      } catch {
        v = [];
      }
      dirCache.set(dir, v);
    }
    return v;
  };

  // существует ли путь с точным совпадением регистра (идём по сегментам от корня проекта)
  const exact = (abs: string): Found => {
    if (!existsSync(abs)) return { kind: 'missing' };
    const rel = relative(root, abs);
    if (rel.startsWith('..') || /^[a-zA-Z]:/.test(rel)) return { kind: 'ok' }; // за пределами проекта не проверяем регистр
    let dir = root;
    const actual: string[] = [];
    let caseDiff = false;
    for (const seg of rel.split(sep).filter(Boolean)) {
      const list = ls(dir);
      if (list.includes(seg)) {
        actual.push(seg);
        dir = join(dir, seg);
      } else {
        const alt = list.find((x) => x.toLowerCase() === seg.toLowerCase());
        if (!alt) return { kind: 'missing' };
        actual.push(alt);
        dir = join(dir, alt);
        caseDiff = true;
      }
    }
    return caseDiff ? { kind: 'case', actual: actual.join('/') } : { kind: 'ok' };
  };

  const rootBases = [root, join(root, 'public'), join(root, 'static'), join(root, 'www'), join(root, 'dist'), join(root, 'src')];
  const out: Finding[] = [];
  const seen = new Set<string>();

  // папка сайта = самая верхняя папка вокруг файла (не выше корня проекта), где лежит index.html.
  // Сервер раздаёт именно её, поэтому всё, что лежит выше, по ссылке не откроется
  const siteRootOf = (abs: string): string => {
    let dir = dirname(abs);
    let best: string | null = null;
    for (;;) {
      if (existsSync(join(dir, 'index.html'))) best = dir;
      if (dir === root) break;
      const parent = dirname(dir);
      if (parent === dir || relative(root, parent).startsWith('..')) break;
      dir = parent;
    }
    return best ?? dirname(abs);
  };

  const check = (file: WebFile, isCss: boolean) => {
    for (const { ref: raw, line } of refsOf(file, isCss)) {
      const ref = clean(raw);
      if (!ref) continue;
      const key = `${file.rel}|${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let cands: string[];
      if (ref.startsWith('/')) {
        const rel = ref.replace(/^\/+/, '');
        cands = [...new Set([dirname(file.abs), ...rootBases])].map((b) => resolve(b, rel));
        // у проекта с сервером /avatars/x.png может отдаваться самим сервером: без такой папки не придираемся
        if (hasServer) {
          const first = rel.split('/')[0];
          if (!rootBases.some((b) => existsSync(join(b, first)))) continue;
        }
      } else {
        cands = [resolve(dirname(file.abs), ref)];
        // сайт без сервера раздаётся из своей папки: ссылка наружу работает с диска, а по адресу сайта даст 404
        if (!hasServer && existsSync(cands[0])) {
          const siteRoot = siteRootOf(file.abs);
          if (relative(siteRoot, cands[0]).startsWith('..')) {
            out.push({
              kind: 'link',
              severity: 'warn',
              message: tr('{0}: ссылка на {1} выходит за пределы папки сайта ({2}). С диска откроется, а по адресу сайта и после выкладки нет', file.rel, ref, relative(root, siteRoot).split(sep).join('/') || '.'),
              file: file.rel,
              line,
              ref,
            });
            continue;
          }
        }
      }
      const res = cands.map(exact);
      if (res.some((r) => r.kind === 'ok')) continue;
      const wrongCase = res.find((r): r is { kind: 'case'; actual: string } => r.kind === 'case');
      if (wrongCase) {
        out.push({
          kind: 'link',
          severity: 'warn',
          message: tr('{0}: ссылка на {1}, а файл называется {2}. Локально работает, на сервере с Linux не откроется (регистр букв важен)', file.rel, ref, wrongCase.actual),
          file: file.rel,
          line,
          ref,
        });
      } else {
        out.push({ kind: 'link', severity: 'warn', message: tr('{0}: ссылка на {1}, а такого файла нет', file.rel, ref), file: file.rel, line, ref });
      }
    }
  };

  for (const h of web.html) check(h, false);
  for (const c of web.css) check(c, true);
  return out;
}
