import { EN } from './i18n-en.ts';

// Язык интерфейса. Ключ — русская строка как в коде: по-русски показываем её же, по-английски берём перевод из EN.
// Подстановки: {0}, {1}… (шаблонные строки с ${…} внутри t(…) не нужны и запрещены тестом).

export type Lang = 'ru' | 'en';

let current: Lang = 'ru';

export function setLang(l: Lang) {
  current = l;
}

export function getLang(): Lang {
  return current;
}

// 'auto' → по языку самого VS Code: русский — русский, всё остальное — английский
export function resolveLang(setting: string | undefined, vscodeLanguage: string | undefined): Lang {
  if (setting === 'ru' || setting === 'en') return setting;
  return /^ru\b/i.test(vscodeLanguage ?? '') ? 'ru' : 'en';
}

export function tr(ru: string, ...args: unknown[]): string {
  const s = current === 'en' ? (EN[ru] ?? ru) : ru;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) >= args.length ? m : String(args[Number(i)]))) : s;
}

// слово по числу: plural(5, ['файл','файла','файлов'], ['file','files'])
export function plural(n: number, ru: [string, string, string], en: [string, string]): string {
  if (current === 'en') return n === 1 ? en[0] : en[1];
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return ru[2];
  if (b > 1 && b < 5) return ru[1];
  if (b === 1) return ru[0];
  return ru[2];
}

// пометка «переведи позже»: строка остаётся как есть, но попадает в словарь; перевод делаем там, где её показываем
export const N = (s: string): string => s;
