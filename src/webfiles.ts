import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// какие папки не смотрим (зависимости, сборка, данные)
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'data', 'vendor', 'android', 'ios']);

export interface WebFile {
  abs: string;
  rel: string;
  src: string;
}

// все HTML и CSS проекта (без минифицированных и без огромных файлов)
export function collectWeb(root: string, overrides?: Map<string, string>): { html: WebFile[]; css: WebFile[] } {
  const html: WebFile[] = [];
  const css: WebFile[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen++ < 3000) {
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
      const isHtml = /\.html?$/i.test(e.name);
      const isCss = /\.css$/i.test(e.name) && !/\.min\./.test(e.name);
      if (!isHtml && !isCss) continue;
      try {
        if (statSync(abs).size > 1_000_000) continue;
        // файл открыт и не сохранён: берём текст из редактора
        const file = { abs, rel: relative(root, abs).replace(/\\/g, '/'), src: overrides?.get(abs.toLowerCase()) ?? readFileSync(abs, 'utf8') };
        (isHtml ? html : css).push(file);
      } catch {
        // пропускаем нечитаемое
      }
    }
  }
  return { html, css };
}
