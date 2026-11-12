import * as vscode from 'vscode';
import type { ServiceView } from './model.ts';
import type { Finding, Report } from './checks.ts';

const STATUS_TEXT = { running: 'запущен', crashed: 'упал', stopped: 'остановлен' } as const;

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
      const ok = new vscode.TreeItem('Проблем не найдено');
      ok.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      ok.description = this.report ? `маршрутов ${this.report.stats.routes}, запросов ${this.report.stats.calls}` : '';
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
    if (f.file) item.command = { command: 'quorvox.openFinding', title: 'Открыть', arguments: [f.file, f.line ?? 1] };
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
    item.description = STATUS_TEXT[s.status] + (s.url ? ` · ${s.url.replace('http://', '')}` : '');
    item.contextValue = `svc ${s.status}${s.url ? ' live' : ''}`;
    item.iconPath =
      s.status === 'running'
        ? new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('testing.iconPassed'))
        : s.status === 'crashed'
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
          : new vscode.ThemeIcon('circle-outline');
    item.tooltip = new vscode.MarkdownString(
      `**${s.name}** — ${STATUS_TEXT[s.status]}\n\n\`${s.command}\`\n\nпапка: \`${s.dir}\`` +
        (s.autoRestart ? '\n\nавтоперезапуск при изменении файлов' : '\n\nсервис следит за файлами сам') +
        (s.url ? `\n\nс автообновлением: ${s.url}` : ''),
    );
    // клик по сервису — открыть дашборд с логами только этого сервиса
    item.command = { command: 'quorvox.dashboard', title: 'Логи', arguments: [s.name] };
    return item;
  }
}
