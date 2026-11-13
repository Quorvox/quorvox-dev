import { relative } from 'node:path';
import type { Stack } from './stack.ts';
import type { Status } from './runner.ts';
import type { Finding, Report } from './checks.ts';
import { tr } from './i18n.ts';

// то, что показываем в боковой панели и на дашборде
export interface ServiceView {
  name: string;
  status: Status;
  command: string;
  dir: string;
  url: string | null;
  lan: string | null; // адрес для телефона в локальной сети, пока доступ включён
  autoRestart: boolean;
}

// сводка проверок для дашборда (список режем, чтобы не гонять сотни строк)
export interface ChecksView {
  findings: Finding[];
  total: number;
  errors: number;
  warns: number;
  stats: { routes: number; calls: number };
}

export function checksView(report: Report | null): ChecksView | null {
  if (!report) return null;
  const f = report.findings;
  return {
    findings: f.slice(0, 40),
    total: f.length,
    errors: f.filter((x) => x.severity === 'error').length,
    warns: f.filter((x) => x.severity === 'warn').length,
    stats: { routes: report.stats.routes, calls: report.stats.calls },
  };
}

export function snapshot(stack: Stack | null, root?: string): ServiceView[] {
  if (!stack) return [];
  return stack.runners.map((r) => ({
    name: r.def.name,
    status: r.status,
    command: r.def.kind === 'static' ? tr('встроенный сервер для сайта (без бэкенда)') : r.def.command,
    dir: root ? relative(root, r.def.cwd) || '.' : r.def.cwd,
    url: r.proxy?.port ? `http://localhost:${r.proxy.port}` : null,
    lan: r.proxy?.lanUrl() ?? null,
    autoRestart: !r.def.selfWatch,
  }));
}
