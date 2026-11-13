import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { mapHtml } from './map-html.ts';
import { localizeHtml } from './webi18n.ts';
import { buildMap } from './projectmap.ts';
import { tr } from './i18n.ts';

export interface MapDeps {
  root(): string | undefined;
  openFile(file: string, line: number): void;
}

// вкладка «Карта проекта»
export class MapPanel {
  private panel: vscode.WebviewPanel | null = null;
  private deps: MapDeps;
  private ready = false;

  constructor(deps: MapDeps) {
    this.deps = deps;
  }

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('quorvox.map', tr('Quorvox: карта'), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.webview.html = localizeHtml(mapHtml(randomBytes(16).toString('hex')));
    panel.webview.onDidReceiveMessage((msg: { cmd: string; file?: string; line?: number }) => {
      if (msg.cmd === 'ready') {
        this.ready = true;
        this.send();
      } else if (msg.cmd === 'refresh') {
        this.send();
      } else if (msg.cmd === 'openFinding' && msg.file) {
        this.deps.openFile(msg.file, msg.line ?? 1);
      }
    });
    panel.onDidDispose(() => {
      this.panel = null;
      this.ready = false;
    });
  }

  // язык сменили: перерисовать вкладку на новом языке (страница сама попросит данные заново)
  relocalize() {
    if (!this.panel) return;
    this.ready = false;
    this.panel.title = tr('Quorvox: карта');
    this.panel.webview.html = localizeHtml(mapHtml(randomBytes(16).toString('hex')));
  }

  isOpen() {
    return this.panel !== null;
  }

  // перестроить карту (вызывается и при изменении файлов, пока вкладка открыта)
  send() {
    if (!this.panel || !this.ready) return;
    const dir = this.deps.root();
    if (!dir) {
      void this.panel.webview.postMessage({ type: 'error', message: tr('нет открытой папки') });
      return;
    }
    try {
      void this.panel.webview.postMessage({ type: 'map', map: buildMap(dir) });
    } catch (e) {
      void this.panel.webview.postMessage({ type: 'error', message: (e as Error).message });
    }
  }

  dispose() {
    this.panel?.dispose();
  }
}
