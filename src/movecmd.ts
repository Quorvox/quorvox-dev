import * as vscode from 'vscode';
import { join, dirname, basename, relative, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { planMove, applyToDisk, makeSnapshot, undoSnapshot } from './mover.ts';
import type { MovePlan, Snapshot } from './mover.ts';
import { tr } from './i18n.ts';

// Команда «Переложить с починкой ссылок» и «Отменить перенос».
// Всё тяжёлое (план, правки, откат) лежит в mover.ts; здесь только окна и связка с VS Code.

export interface MoveDeps {
  root(): string | undefined;
  // перезапустить проверки и вернуть число замечаний (до и после переноса сравниваем)
  checkCount(): number;
  log(line: string): void;
}

export interface MoveOptions {
  // для тестов и скриптов: без окон
  silent?: boolean;
  from?: string[];
  to?: string; // папка-назначение
  rename?: string; // новое имя (если переносим один файл/папку)
  viaEdit?: boolean; // применить через WorkspaceEdit, а не напрямую на диск
}

export interface MoveResult {
  ok: boolean;
  errors: string[];
  plan?: MovePlan;
  before?: number;
  after?: number;
}

interface Saved {
  snap: Snapshot;
  root: string;
  when: number;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

export function registerMove(ctx: vscode.ExtensionContext, deps: MoveDeps): vscode.Disposable[] {
  const storeFile = () => {
    const dir = ctx.globalStorageUri.fsPath;
    mkdirSync(dir, { recursive: true });
    const id = createHash('sha1').update(deps.root() ?? '').digest('hex').slice(0, 12);
    return join(dir, `last-move-${id}.json`);
  };
  const save = (s: Saved) => writeFileSync(storeFile(), JSON.stringify(s), 'utf8');
  const load = (): Saved | null => {
    try {
      return JSON.parse(readFileSync(storeFile(), 'utf8')) as Saved;
    } catch {
      return null;
    }
  };

  // файлы, которые открыты и не сохранены: перенос по диску затрёт или запутает правки
  const dirtyAmong = (paths: Set<string>) =>
    vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && [...paths].some((p) => inside(d.uri.fsPath, p))).map((d) => d.uri.fsPath);

  async function pickSources(uri?: vscode.Uri, many?: vscode.Uri[]): Promise<string[] | null> {
    if (many?.length) return many.map((u) => u.fsPath);
    if (uri) return [uri.fsPath];
    const r = deps.root();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: r ? vscode.Uri.file(r) : undefined,
      openLabel: tr('Переложить это'),
      title: tr('Что переложить?'),
    });
    return picked?.length ? picked.map((u) => u.fsPath) : null;
  }

  function describe(plan: MovePlan, root: string): string {
    const rel = (p: string) => relative(root, p).split(sep).join('/');
    const files = new Set([...plan.edits.map((e) => e.file), ...plan.inserts.map((i) => i.file)]);
    const lines = [
      ...plan.renames.map((r) => tr('Переносим: {0} → {1}', rel(r.from), rel(r.to))),
      tr('Поправим ссылок: {0}, в файлах: {1}', plan.edits.length, files.size),
    ];
    if (plan.inserts.length) lines.push(tr('Допишем в сервер строк отдачи папок: {0}', plan.inserts.length));
    if (plan.warnings.length) lines.push('', tr('Не смогу поправить сам:'), ...plan.warnings.slice(0, 8).map((w) => '• ' + w));
    if (plan.mentions.length) lines.push('', tr('Старый путь упоминается тут, глянь руками:'), ...plan.mentions.slice(0, 8).map((m) => `• ${m.file}:${m.line}  ${m.text}`));
    return lines.join('\n');
  }

  // новый путь файла после переноса (файл мог переехать сам или вместе с папкой)
  const newPathOf = (plan: MovePlan, p: string) => {
    for (const r of plan.renames) if (inside(p, r.from)) return join(r.to, relative(r.from, p));
    return p;
  };

  // наш собственный перенос не должен чиниться дважды
  let selfMove = false;
  let pendingSave = new Set<string>();

  async function saveTouched() {
    const want = pendingSave;
    pendingSave = new Set();
    if (!want.size) return;
    for (let i = 0; i < 10; i++) {
      for (const d of vscode.workspace.textDocuments) if (d.isDirty && want.has(d.uri.fsPath.toLowerCase())) await d.save();
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Перетащил файл мышкой или нажал F2: VS Code сообщает до переноса, и мы дописываем в тот же перенос правки ссылок.
  // Так работает и Ctrl+Z: он откатывает и перенос, и наши правки.
  async function onWillRename(e: vscode.FileWillRenameEvent): Promise<vscode.WorkspaceEdit | undefined> {
    const root = deps.root();
    if (selfMove || !root || !vscode.workspace.getConfiguration('quorvox').get('fixLinksOnMove', true)) return;
    const pairs = e.files.filter((f) => f.oldUri.scheme === 'file' && f.newUri.scheme === 'file').map((f) => ({ from: f.oldUri.fsPath, to: f.newUri.fsPath }));
    if (!pairs.length || pairs.some((p) => !inside(p.from, root) || !inside(p.to, root))) return;
    let plan: MovePlan;
    try {
      plan = planMove(root, pairs);
    } catch {
      return;
    }
    if (plan.errors.length || (!plan.edits.length && !plan.inserts.length)) {
      if (!plan.errors.length && (plan.warnings.length || plan.mentions.length)) void vscode.window.showWarningMessage(tr('Перенос сделан, но {0} мест со старым путём я поправить не смог. Смотри панель «Вывод» → Quorvox Dev.', plan.warnings.length + plan.mentions.length));
      for (const w of plan.warnings) deps.log(`[move] ${w}`);
      for (const m of plan.mentions) deps.log(tr('[move] старый путь упоминается: {0}:{1}  {2}', m.file, m.line, m.text));
      return;
    }
    const files = new Set([...plan.edits.map((x) => x.file), ...plan.inserts.map((i) => i.file)]);
    const dirty = dirtyAmong(files);
    if (dirty.length) {
      void vscode.window.showWarningMessage(tr('Ссылки при переносе не поправил: не сохранены {0}. Сохрани и повтори, или отмени перенос (Ctrl+Z).', dirty.map((f) => basename(f)).join(', ')));
      return;
    }
    const we = new vscode.WorkspaceEdit();
    const docs = new Map<string, vscode.TextDocument>();
    const doc = async (f: string) => {
      let d = docs.get(f);
      if (!d) docs.set(f, (d = await vscode.workspace.openTextDocument(vscode.Uri.file(f))));
      return d;
    };
    for (const x of plan.edits) {
      const d = await doc(x.file);
      const range = new vscode.Range(d.positionAt(x.start), d.positionAt(x.end));
      if (d.getText(range) !== x.oldText) return;
      we.replace(vscode.Uri.file(x.file), range, x.newText);
    }
    for (const i of plan.inserts) {
      const d = await doc(i.file);
      we.insert(vscode.Uri.file(i.file), d.positionAt(i.offset), i.text);
    }
    // после переноса сохраняем затронутые файлы сами: иначе при выключенном автосохранении правки повисли бы несохранёнными
    pendingSave = new Set([...files].map((f) => newPathOf(plan, f).toLowerCase()));
    deps.log(tr('[move] перенос из проводника: поправил ссылок {0}{1}', plan.edits.length, plan.inserts.length ? tr(', дописал отдачу папки в сервер ({0})', plan.inserts.length) : ''));
    void vscode.window.showInformationMessage(tr('Quorvox поправил ссылки при переносе: {0}{1}. Ctrl+Z отменит и перенос, и правки.', plan.edits.length, plan.inserts.length ? tr(' + строка отдачи папки на сервере') : ''));
    setTimeout(() => deps.checkCount(), 1500);
    return we;
  }

  async function applyViaEdit(plan: MovePlan, confirm: boolean): Promise<boolean> {
    const we = new vscode.WorkspaceEdit();
    const meta = confirm ? { label: tr('Quorvox: поправить ссылку'), needsConfirmation: true } : undefined;
    const docs = new Map<string, vscode.TextDocument>();
    const doc = async (f: string) => {
      let d = docs.get(f);
      if (!d) {
        d = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        docs.set(f, d);
      }
      return d;
    };
    for (const e of plan.edits) {
      const d = await doc(e.file);
      const range = new vscode.Range(d.positionAt(e.start), d.positionAt(e.end));
      if (d.getText(range) !== e.oldText) throw new Error(tr('{0}: текст изменился после подготовки плана, повтори', basename(e.file)));
      we.replace(vscode.Uri.file(e.file), range, e.newText, meta);
    }
    for (const i of plan.inserts) {
      const d = await doc(i.file);
      we.insert(vscode.Uri.file(i.file), d.positionAt(i.offset), i.text, meta);
    }
    for (const r of plan.renames) we.renameFile(vscode.Uri.file(r.from), vscode.Uri.file(r.to), { overwrite: false }, confirm ? { label: tr('Quorvox: переместить'), needsConfirmation: true } : undefined);
    selfMove = true;
    let ok: boolean;
    try {
      ok = await vscode.workspace.applyEdit(we);
    } finally {
      selfMove = false;
    }
    if (!ok) return false;
    // правки лежат в открытых документах: сохраняем те, что тронули мы
    const touched = new Set([...plan.edits.map((e) => newPathOf(plan, e.file)), ...plan.inserts.map((i) => newPathOf(plan, i.file))].map((p) => p.toLowerCase()));
    for (const d of vscode.workspace.textDocuments) if (d.isDirty && touched.has(d.uri.fsPath.toLowerCase())) await d.save();
    return plan.renames.every((r) => existsSync(r.to));
  }

  async function move(a?: vscode.Uri | MoveOptions, b?: vscode.Uri[]): Promise<MoveResult | undefined> {
    const root = deps.root();
    if (!root) {
      void vscode.window.showWarningMessage(tr('Открой папку проекта: переносить можно только внутри проекта.'));
      return { ok: false, errors: [tr('нет открытой папки')] };
    }
    const opts: MoveOptions = a && !(a instanceof vscode.Uri) ? a : {};
    const silent = !!opts.silent;

    const sources = silent ? (opts.from ?? []) : await pickSources(a instanceof vscode.Uri ? a : undefined, b);
    if (!sources?.length) return;

    let destDir: string;
    if (silent) destDir = opts.to ?? '';
    else {
      const d = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(dirname(sources[0])),
        openLabel: tr('Переложить сюда'),
        title: tr('Куда переложить? (можно создать новую папку в окне выбора)'),
      });
      if (!d?.length) return;
      destDir = d[0].fsPath;
    }

    let newName: string | undefined = opts.rename;
    if (!silent && sources.length === 1) {
      newName = await vscode.window.showInputBox({
        title: tr('Новое имя (можно оставить как есть)'),
        value: basename(sources[0]),
        validateInput: (v) => (!v.trim() || /[\\/:*?"<>|]/.test(v) ? tr('Имя без символов \\ / : * ? " < > |') : undefined),
      });
      if (newName === undefined) return;
    }
    const pairs = sources.map((from) => ({ from, to: join(destDir, sources.length === 1 && newName ? newName.trim() : basename(from)) }));
    const pairs2 = pairs.filter((p) => p.from.toLowerCase() !== p.to.toLowerCase());
    if (!pairs2.length) return { ok: false, errors: [tr('файл уже там')] };

    const dirty = dirtyAmong(new Set([...pairs2.map((p) => p.from)]));
    if (dirty.length) {
      const msg = tr('Сначала сохрани файлы ({0}), потом повтори перенос.', dirty.map((f) => basename(f)).join(', '));
      if (!silent) void vscode.window.showWarningMessage(msg);
      return { ok: false, errors: [msg] };
    }

    const plan = planMove(root, pairs2);
    if (plan.errors.length) {
      if (!silent) void vscode.window.showErrorMessage(tr('Так переносить нельзя:\n') + plan.errors.join('\n'), { modal: true });
      return { ok: false, errors: plan.errors, plan };
    }
    const editDirty = dirtyAmong(new Set([...plan.edits.map((e) => e.file), ...plan.inserts.map((i) => i.file)]));
    if (editDirty.length) {
      const msg = tr('Сначала сохрани: {0} — в них надо поправить ссылки.', editDirty.map((f) => basename(f)).join(', '));
      if (!silent) void vscode.window.showWarningMessage(msg);
      return { ok: false, errors: [msg], plan };
    }

    let preview = false;
    if (!silent) {
      const PREVIEW = tr('Показать правки');
      const NOW = tr('Переложить сразу');
      const pick = await vscode.window.showInformationMessage(tr('Перекладка с починкой ссылок'), { modal: true, detail: describe(plan, root) }, PREVIEW, NOW);
      if (!pick) return { ok: false, errors: [tr('отменено')], plan };
      preview = pick === PREVIEW;
    }

    const before = deps.checkCount();
    const snap = makeSnapshot(plan);
    let done: boolean;
    try {
      done = opts.viaEdit || preview ? await applyViaEdit(plan, preview) : (applyToDisk(plan), true);
    } catch (e) {
      const msg = (e as Error).message;
      if (!silent) void vscode.window.showErrorMessage(tr('Перенос не получился: ') + msg);
      return { ok: false, errors: [msg], plan };
    }
    if (!done) {
      // отказались в предпросмотре или часть не применилась: пробуем вернуть как было, если что-то успело поехать
      if (plan.renames.some((r) => existsSync(r.to))) undoSnapshot(snap);
      return { ok: false, errors: [tr('отменено в предпросмотре')], plan };
    }
    save({ snap, root, when: Date.now() });
    const after = deps.checkCount();
    deps.log(tr('[move] перенёс {0}, поправил ссылок {1}; замечаний было {2}, стало {3}', plan.renames.length, plan.edits.length, before, after));
    if (!silent) {
      const UNDO = tr('Отменить перенос');
      const verdict = after > before ? tr('Проверки нашли новые замечания ({0} → {1}), глянь панель «Проверки».', before, after) : tr('Проверки: замечаний {0} → {1}.', before, after);
      void vscode.window.showInformationMessage(tr('Готово: перенёс {0}, поправил ссылок {1}. {2}', plan.renames.length, plan.edits.length, verdict), UNDO).then((p) => {
        if (p === UNDO) void undo();
      });
    }
    return { ok: true, errors: [], plan, before, after };
  }

  async function undo(opts?: { silent?: boolean }): Promise<{ ok: boolean; restored: number } | undefined> {
    const saved = load();
    const silent = !!opts?.silent;
    if (!saved || saved.root !== deps.root()) {
      if (!silent) void vscode.window.showInformationMessage(tr('Нечего отменять: последнего переноса в этом проекте нет.'));
      return { ok: false, restored: 0 };
    }
    const dirty = dirtyAmong(new Set(Object.keys(saved.snap.texts).map((p) => newPathOf({ renames: saved.snap.renames.map((r) => ({ ...r, isDir: false })) } as MovePlan, p))));
    if (dirty.length) {
      const msg = tr('Сначала сохрани или закрой: {0}.', dirty.map((f) => basename(f)).join(', '));
      if (!silent) void vscode.window.showWarningMessage(msg);
      return { ok: false, restored: 0 };
    }
    if (!silent) {
      const YES = tr('Отменить');
      const pick = await vscode.window.showWarningMessage(tr('Вернуть файлы и ссылки как были до последнего переноса? Правки, сделанные после переноса в этих файлах, пропадут.'), { modal: true }, YES);
      if (pick !== YES) return;
    }
    // переносы назад делаем средствами VS Code: он сам отпустит наблюдателей за папкой (на Windows иначе бывает EBUSY)
    const back = new vscode.WorkspaceEdit();
    for (const rn of [...saved.snap.renames].reverse()) {
      if (existsSync(rn.to) && !existsSync(rn.from)) back.renameFile(vscode.Uri.file(rn.to), vscode.Uri.file(rn.from), { overwrite: false });
    }
    if (back.size) await vscode.workspace.applyEdit(back);
    const r = undoSnapshot(saved.snap);
    try {
      rmSync(storeFile());
    } catch {
      // нечего удалять
    }
    deps.checkCount();
    deps.log(tr('[move] перенос отменён, файлов восстановлено {0}', r.restored));
    if (!silent) void vscode.window.showInformationMessage(tr('Перенос отменён, всё как было.'));
    return { ok: true, restored: r.restored };
  }

  return [
    vscode.commands.registerCommand('quorvox.move', move),
    vscode.commands.registerCommand('quorvox.moveUndo', undo),
    vscode.workspace.onWillRenameFiles((e) => e.waitUntil(onWillRename(e))),
    vscode.workspace.onDidRenameFiles(() => void saveTouched()),
  ];
}
