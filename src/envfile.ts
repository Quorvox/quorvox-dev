import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanProject, envUsage } from './checks.ts';
import type { EnvUse } from './checks.ts';

// .env.example из кода: только имена переменных и подсказки, без значений.
// Если файл уже есть, существующее не трогаем, дописываем только недостающее.

export interface EnvExample {
  text: string; // что записать в файл целиком
  added: string[]; // какие переменные добавлены
  existing: boolean;
}

export function renderEnvExample(usage: Map<string, EnvUse>, existingText?: string): EnvExample {
  const have = new Set(
    [...(existingText ?? '').matchAll(/^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]),
  );
  const names = [...usage.keys()].filter((n) => !have.has(n)).sort();
  const block = names
    .map((n) => {
      const u = usage.get(n)!;
      const note = u.required ? 'нужна, запасного значения в коде нет' : 'необязательная, в коде есть запасное значение';
      return `# ${u.file}:${u.line} — ${note}\n${n}=`;
    })
    .join('\n\n');
  if (existingText === undefined) {
    return {
      text: '# Шаблон переменных окружения. Скопируй в .env и впиши свои значения. Сам .env никуда не отправляй.\n\n' + block + (block ? '\n' : ''),
      added: names,
      existing: false,
    };
  }
  if (!names.length) return { text: existingText, added: [], existing: true };
  const sep = existingText.endsWith('\n') ? '\n' : '\n\n';
  return { text: existingText + sep + '# добавлено Quorvox: переменные, которые читает код, но которых здесь не было\n' + block + '\n', added: names, existing: true };
}

export function buildEnvExample(root: string): EnvExample {
  const usage = envUsage(scanProject(root).servers);
  let existing: string | undefined;
  try {
    existing = readFileSync(join(root, '.env.example'), 'utf8');
  } catch {
    existing = undefined;
  }
  return renderEnvExample(usage, existing);
}
