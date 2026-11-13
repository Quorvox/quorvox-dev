import * as vscode from 'vscode';
import type { ServiceView } from './model.ts';
import type { Finding, Report } from './checks.ts';
import { tr } from './i18n.ts';

const STATUS_TEXT = () => ({ running: tr('запущен'), crashed: tr('упал'), stopped: tr('остановлен') }) as const;

// результаты проверок в боковой панели
export class ChecksTree implements vscode.TreeDataProvider<Finding | null> {
  private changed = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this.changed.event;
  private report: Report | null = null;

  set(report: Report | null) {
    this.report = report;
    this.changed.fire();
  }

  getChildren(): (Finding | null)[] {
    if (!this.report) return [];
    return this.report.findings.length ? this.report.findings : [null];
  }

  getTreeItem(f: Finding | null): vscode.TreeItem {
    if (!f) {
      const ok = new vscode.TreeItem(tr('Проблем не найдено'));
      ok.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      ok.description = this.report ? tr('маршрутов {0}, запросов {1}', this.report.stats.routes, this.report.stats.calls) : '';
      return ok;
    }
    const item = new vscode.TreeItem(f.message, vscode.TreeItemCollapsibleState.None);
    item.description = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '';
    item.tooltip = f.message;
    item.iconPath =
      f.severity === 'error'
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
        : f.severity === 'warn'
          ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
          : new vscode.ThemeIcon('info');
    if (f.file) item.command = { command: 'quorvox.openFinding', title: tr('Открыть'), arguments: [f.file, f.line ?? 1] };
    return item;
  }
}

// список сервисов в боковой панели
export class ServicesTree implements vscode.TreeDataProvider<ServiceView> {
  private changed = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this.changed.event;
  private items: ServiceView[] = [];

  set(items: ServiceView[]) {
    this.items = items;
    this.changed.fire();
  }

  getChildren(): ServiceView[] {
    return this.items;
  }

  getTreeItem(s: ServiceView): vscode.TreeItem {
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.description = STATUS_TEXT()[s.status] + (s.url ? ` · ${s.url.replace('http://', '')}` : '');
    item.contextValue = `svc ${s.status}${s.url ? ' live' : ''}`;
    item.iconPath =
      s.status === 'running'
        ? new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('testing.iconPassed'))
        : s.status === 'crashed'
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
          : new vscode.ThemeIcon('circle-outline');
    item.tooltip = new vscode.MarkdownString(
      tr('**{0}** — {1}\n\n`{2}`\n\nпапка: `{3}`', s.name, STATUS_TEXT()[s.status], s.command, s.dir) +
        (s.autoRestart ? tr('\n\nавтоперезапуск при изменении файлов') : tr('\n\nсервис следит за файлами сам')) +
        (s.url ? tr('\n\nс автообновлением: {0}', s.url) : ''),
    );
    // клик по сервису — открыть дашборд с логами только этого сервиса
    item.command = { command: 'quorvox.dashboard', title: tr('Логи'), arguments: [s.name] };
    return item;
  }
}
