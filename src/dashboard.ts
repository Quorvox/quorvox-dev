import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { dashboardHtml } from './dashboard-html.ts';
import { localizeHtml } from './webi18n.ts';
import type { ServiceView, ChecksView } from './model.ts';
import type { LogLine } from './logbuf.ts';

// выкладка, по которой ждём решения: «работает» (удалить копию старой версии) или «откатить»
export interface ReleaseInfo {
  host: string;
  ts: string;
  at: number;
}

export interface DashboardDeps {
  release(): ReleaseInfo | null;
  services(): ServiceView[];
  checks(): ChecksView | null;
  history(): LogLine[];
  command(msg: { cmd: string; name?: string; file?: string; line?: number }): void;
}

// вкладка-дашборд: карточки сервисов и живые логи
export class Dashboard {
  private panel: vscode.WebviewPanel | null = null;
  private deps: DashboardDeps;
  private ready = false;
  private filter: string | null = null;
  private queue: LogLine[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: DashboardDeps) {
    this.deps = deps;
  }

  show(filter?: string) {
    this.filter = filter ?? null;
    if (this.panel) {
      this.panel.reveal(undefined, true);
      if (this.ready) this.post({ type: 'filter', name: this.filter ?? '' });
      return;
    }
    const panel = vscode.window.createWebviewPanel('quorvox.dashboard', 'Quorvox', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.webview.html = localizeHtml(dashboardHtml(randomBytes(16).toString('hex')));
    panel.webview.onDidReceiveMessage((msg: { cmd: string; name?: string; file?: string; line?: number }) => {
      if (msg.cmd === 'ready') {
        this.ready = true;
        this.post({
          type: 'init',
          services: this.deps.services(),
          checks: this.deps.checks(),
          release: this.deps.release(),
          lines: this.deps.history(),
          filter: this.filter,
        });
      } else {
        this.deps.command(msg);
      }
    });
    panel.onDidDispose(() => {
      this.panel = null;
      this.ready = false;
      this.queue = [];
    });
  }

  isOpen() {
    return this.panel !== null;
  }

  // плашка «Выложено. Работает?» (null — убрать)
  showRelease(info: ReleaseInfo | null) {
    if (this.ready) this.post({ type: 'release', release: info });
  }

  // показать окно с QR-кодом (info = null — закрыть)
  qr(info: { name: string; url: string; svg: string } | null) {
    if (!this.ready) return;
    this.post(info ? { type: 'qr', open: true, ...info } : { type: 'qr', open: false });
  }

  relocalize() {
    if (!this.panel) return;
    this.ready = false;
    this.panel.webview.html = localizeHtml(dashboardHtml(randomBytes(16).toString('hex')));
  }

  update() {
    if (this.ready) this.post({ type: 'state', services: this.deps.services(), checks: this.deps.checks() });
  }

  // строки копим и отправляем пачкой, чтобы болтливый сервер не заваливал webview
  log(line: LogLine) {
    if (!this.ready) return;
    this.queue.push(line);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const lines = this.queue;
      this.queue = [];
      this.post({ type: 'log', lines });
    }, 100);
  }

  private post(msg: unknown) {
    void this.panel?.webview.postMessage(msg);
  }

  dispose() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.panel?.dispose();
  }
}
