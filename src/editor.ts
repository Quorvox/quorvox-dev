import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report, Finding } from './checks.ts';
import {
  classContext,
  apiContext,
  envContext,
  routeItems,
  insertPath,
  classAtCursor,
  envAtCursor,
  apiPathAtCursor,
  routesForPath,
  cssRuleAt,
} from './editorlogic.ts';

// Подсказки прямо в редакторе: подчёркивания ошибок, автодополнение, переход к определению и подсказка при наведении.
// Вся логика в editorlogic.ts и анализаторе; здесь только подключение к VS Code.

export type Feature = 'diagnostics' | 'completions';

export interface EditorDeps {
  root(): string | undefined;
  report(): Report | null;
  enabled(feature: Feature): boolean;
}

const SELECTOR: vscode.DocumentSelector = [
  { language: 'html' },
  { language: 'javascript' },
  { language: 'typescript' },
  { language: 'javascriptreact' },
  { language: 'typescriptreact' },
];

// ---------- подчёркивания ----------

// какой кусок строки подчеркнуть: адрес в api('…'), имя класса, ссылка. Иначе вся строка
function refine(f: Finding, text: string): [number, number] | null {
  if (f.kind === 'route' || f.kind === 'method') {
    const m = /\b(?:api|fetch)\s*\(\s*(['"`])(?:\\.|(?!\1)[^\\\n])*\1/.exec(text);
    return m ? [m.index, m.index + m[0].length] : null;
  }
  if (f.kind === 'css') {
    const name = /^Класс \.([\w-]+)/.exec(f.message)?.[1];
    const i = name ? text.search(new RegExp(`(?<![\\w-])${name.replace(/[-]/g, '\\-')}(?![\\w-])`)) : -1;
    return name && i >= 0 ? [i, i + name.length] : null;
  }
  if (f.kind === 'link') {
    const ref = /ссылка на (\S+?)(?:,| выходит)/.exec(f.message)?.[1];
    const i = ref ? text.indexOf(ref) : -1;
    return ref && i >= 0 ? [i, i + ref.length] : null;
  }
  return null;
}

function publishDiagnostics(collection: vscode.DiagnosticCollection, deps: EditorDeps) {
  collection.clear();
  const report = deps.report();
  const dir = deps.root();
  if (!deps.enabled('diagnostics') || !report || !dir) return;

  const open = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.fsPath.toLowerCase(), d]));
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const f of report.findings) {
    if (!f.file || !f.line) continue;
    // справочное (мёртвый CSS целиком, нет .env.example) не подчёркиваем: оно не про конкретную строку.
    // Опечатки в классах подчёркиваем всегда, даже «возможные»
    if (f.severity === 'info' && !(f.kind === 'css' && f.message.startsWith('Класс'))) continue;
    const fsPath = join(dir, f.file);
    const doc = open.get(fsPath.toLowerCase());
    const lineNo = f.line - 1;
    let range: vscode.Range;
    if (doc && lineNo < doc.lineCount) {
      const line = doc.lineAt(lineNo);
      const part = refine(f, line.text);
      range = part ? new vscode.Range(lineNo, part[0], lineNo, part[1]) : new vscode.Range(lineNo, line.firstNonWhitespaceCharacterIndex, lineNo, line.text.length);
    } else {
      range = new vscode.Range(lineNo, 0, lineNo, 200);
    }
    // «возможное» (info) — тихая подсказка-точки: в списке проблем не засоряет, но под курсором видна
    const sev = f.severity === 'error' ? vscode.DiagnosticSeverity.Error : f.severity === 'warn' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint;
    const d = new vscode.Diagnostic(range, f.message, sev);
    d.source = 'Quorvox';
    d.code = f.kind;
    const list = byFile.get(fsPath) ?? [];
    list.push(d);
    byFile.set(fsPath, list);
  }
  for (const [file, list] of byFile) collection.set(vscode.Uri.file(file), list);
}

// ---------- автодополнение ----------

function readLines(dir: string, rel: string): string {
  try {
    return readFileSync(join(dir, rel), 'utf8');
  } catch {
    return '';
  }
}

class Completions implements vscode.CompletionItemProvider {
  private deps: EditorDeps;
  constructor(deps: EditorDeps) {
    this.deps = deps;
  }

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    if (!this.deps.enabled('completions')) return undefined;
    const index = this.deps.report()?.index;
    if (!index) return undefined;
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);

    const cc = classContext(before);
    if (cc && index.classes.length) {
      const range = new vscode.Range(pos.line, pos.character - cc.prefix.length, pos.line, pos.character);
      return index.classes.map((c) => {
        const it = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Class);
        it.detail = `CSS · ${c.file}:${c.line}`;
        it.range = range;
        it.sortText = '0' + c.name; // свои классы выше чужих подсказок
        (it as vscode.CompletionItem & { data?: unknown }).data = { file: c.file, line: c.line };
        return it;
      });
    }

    const ac = apiContext(before);
    if (ac && index.routes.length) {
      const start = pos.character - ac.typed.length;
      const range = new vscode.Range(pos.line, start, pos.line, pos.character);
      return routeItems(index, ac).map((r) => {
        const it = new vscode.CompletionItem(r.path, vscode.CompletionItemKind.Reference);
        it.detail = `${r.methods.join(' / ')} · ${r.file}:${r.line}`;
        it.insertText = insertPath(r, ac.quote);
        it.range = range;
        // набрали «clu» без слэша: фильтруем без ведущего слэша
        it.filterText = ac.typed.startsWith('/') || ac.typed === '' ? r.path : r.path.replace(/^\//, '');
        it.sortText = '0' + r.path;
        return it;
      });
    }

    const ec = envContext(before);
    if (ec && index.env.length) {
      return index.env.map((e) => {
        const it = new vscode.CompletionItem(e.name, vscode.CompletionItemKind.Variable);
        it.detail = e.defined ? 'описана в .env' : 'нет ни в одном .env';
        it.documentation = new vscode.MarkdownString(`Используется в \`${e.file}:${e.line}\`${e.required ? ', без запасного значения' : ''}.`);
        return it;
      });
    }
    return undefined;
  }

  // кусок CSS для подсказки читаем только когда пункт выбран
  resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
    const data = (item as vscode.CompletionItem & { data?: { file: string; line: number } }).data;
    const dir = this.deps.root();
    if (data && dir) {
      const rule = cssRuleAt(readLines(dir, data.file), data.line);
      if (rule) item.documentation = new vscode.MarkdownString().appendCodeblock(rule, 'css');
    }
    return item;
  }
}

// ---------- переход к определению ----------

class Definitions implements vscode.DefinitionProvider {
  private deps: EditorDeps;
  constructor(deps: EditorDeps) {
    this.deps = deps;
  }

  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.LocationLink[] | undefined {
    if (!this.deps.enabled('completions')) return undefined;
    const index = this.deps.report()?.index;
    const dir = this.deps.root();
    if (!index || !dir) return undefined;
    const line = doc.lineAt(pos.line).text;

    const cls = classAtCursor(line, pos.character);
    if (cls) {
      const defs = index.classes.filter((c) => c.name === cls.name);
      if (defs.length) {
        const origin = new vscode.Range(pos.line, cls.start, pos.line, cls.end);
        return defs.map((c) => ({ originSelectionRange: origin, targetUri: vscode.Uri.file(join(dir, c.file)), targetRange: new vscode.Range(c.line - 1, 0, c.line - 1, 0) }));
      }
    }
    const ap = apiPathAtCursor(line, pos.character);
    if (ap) {
      const hits = routesForPath(index, ap);
      if (hits.length) {
        return hits.map((r) => ({ targetUri: vscode.Uri.file(join(dir, r.file)), targetRange: new vscode.Range(r.line - 1, 0, r.line - 1, 0) }));
      }
    }
    return undefined;
  }
}

// ---------- подсказка при наведении ----------

class Hovers implements vscode.HoverProvider {
  private deps: EditorDeps;
  constructor(deps: EditorDeps) {
    this.deps = deps;
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!this.deps.enabled('completions')) return undefined;
    const index = this.deps.report()?.index;
    const dir = this.deps.root();
    if (!index || !dir) return undefined;
    const line = doc.lineAt(pos.line).text;

    const cls = classAtCursor(line, pos.character);
    if (cls) {
      const def = index.classes.find((c) => c.name === cls.name);
      const range = new vscode.Range(pos.line, cls.start, pos.line, cls.end);
      if (!def) return new vscode.Hover(new vscode.MarkdownString(`Класса **.${cls.name}** нет ни в одном CSS проекта.`), range);
      const md = new vscode.MarkdownString(`**.${cls.name}** · \`${def.file}:${def.line}\`\n\n`);
      md.appendCodeblock(cssRuleAt(readLines(dir, def.file), def.line), 'css');
      return new vscode.Hover(md, range);
    }

    const ap = apiPathAtCursor(line, pos.character);
    if (ap) {
      const hits = routesForPath(index, ap);
      const md = new vscode.MarkdownString();
      if (!hits.length) md.appendMarkdown('Такого адреса на сервере **не нашёл**.');
      else for (const r of hits) md.appendMarkdown(`\`${r.method} ${r.full}\` → \`${r.file}:${r.line}\`  \n`);
      return new vscode.Hover(md);
    }

    const env = envAtCursor(line, pos.character);
    if (env) {
      const e = index.env.find((x) => x.name === env.name);
      const range = new vscode.Range(pos.line, env.start, pos.line, env.end);
      const md = new vscode.MarkdownString();
      if (!e) md.appendMarkdown(`Переменная **${env.name}**: в серверном коде не нашёл.`);
      else {
        md.appendMarkdown(`Переменная **${e.name}**\n\n`);
        md.appendMarkdown(e.defined ? '✔ описана в `.env`-файле проекта\n\n' : '⚠ не описана ни в одном `.env`\n\n');
        md.appendMarkdown(e.required ? 'В коде используется **без запасного значения**.' : 'В коде есть запасное значение.');
      }
      return new vscode.Hover(md, range);
    }
    return undefined;
  }
}

// ---------- подключение ----------

export function registerEditor(ctx: vscode.ExtensionContext, deps: EditorDeps) {
  const collection = vscode.languages.createDiagnosticCollection('quorvox');
  ctx.subscriptions.push(
    collection,
    vscode.languages.registerCompletionItemProvider(SELECTOR, new Completions(deps), '"', "'", '`', ' ', '/', '.', '-'),
    vscode.languages.registerDefinitionProvider(SELECTOR, new Definitions(deps)),
    vscode.languages.registerHoverProvider(SELECTOR, new Hovers(deps)),
    // открыли файл — подчёркивания должны сразу встать точнее (по куску строки)
    vscode.workspace.onDidOpenTextDocument(() => publishDiagnostics(collection, deps)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('quorvox.editor')) publishDiagnostics(collection, deps);
    }),
  );
  return { publish: () => publishDiagnostics(collection, deps) };
}
