import type { Finding } from './checks.ts';
import type { WebFile } from './webfiles.ts';
import { tr } from './i18n.ts';

// Подсказки для вёрстки: то, что забывают, и потом сайт плохо выглядит на телефоне или хуже читается.
// Только для полных страниц (есть <html>): куски шаблонов не трогаем.

const lineOf = (src: string, idx: number) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
};

export function checkHtml(files: WebFile[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    const src = f.src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    if (!/<html[\s>]/i.test(src)) continue;

    for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
      if (/\balt\s*=/i.test(m[0])) continue;
      out.push({ kind: 'html', severity: 'warn', message: tr('{0}: у картинки нет alt — без него её не прочитают скринридеры и она хуже ищется', f.rel), file: f.rel, line: lineOf(src, m.index!), ref: m[0] });
    }
    const head = /<head[\s>]/i.exec(src);
    const headLine = head ? lineOf(src, head.index) : 1;
    if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(src)) {
      out.push({ kind: 'html', severity: 'warn', message: tr('{0}: нет <meta name="viewport"> — на телефоне страница откроется мелкой, как на компьютере', f.rel), file: f.rel, line: headLine });
    }
    const htmlTag = /<html\b[^>]*>/i.exec(src);
    if (htmlTag && !/\blang\s*=/i.test(htmlTag[0])) {
      out.push({ kind: 'html', severity: 'info', message: tr('{0}: у <html> нет lang — браузеры и читалки хуже понимают язык страницы', f.rel), file: f.rel, line: lineOf(src, htmlTag.index), ref: htmlTag[0] });
    }
    if (!/<title[\s>]/i.test(src)) {
      out.push({ kind: 'html', severity: 'info', message: tr('{0}: нет <title> — вкладка и поисковик покажут адрес вместо названия', f.rel), file: f.rel, line: headLine });
    }
    for (const m of src.matchAll(/<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi)) {
      if (/\brel\s*=\s*["'][^"']*noopener/i.test(m[0])) continue;
      out.push({ kind: 'html', severity: 'info', message: tr('{0}: ссылка с target="_blank" без rel="noopener" — открытая страница получает доступ к твоей', f.rel), file: f.rel, line: lineOf(src, m.index!), ref: m[0] });
    }
  }
  return out;
}
