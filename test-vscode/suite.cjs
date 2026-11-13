// Тест внутри настоящего VS Code (Extension Host). Запускается через test-vscode/run.mjs.
// Проверяет то, что нельзя проверить без редактора: подчёркивания, автодополнение, Ctrl+клик, подсказка, настройки.
const vscode = require('vscode');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  return false;
}

const steps = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    steps.push({ name, ok: true, detail: detail ?? '' });
  } catch (e) {
    steps.push({ name, ok: false, detail: String(e && e.message ? e.message : e) });
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function run() {
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const at = (rel) => vscode.Uri.joinPath(folder, rel);
  const appUri = at('public/js/app.js');
  const htmlUri = at('public/index.html');
  const cfg = vscode.workspace.getConfiguration('quorvox');
  const diagOf = (uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Quorvox');

  await step('расширение запускается и регистрирует команды', async () => {
    const ext = vscode.extensions.getExtension('QuorvoxTeam.quorvox-dev');
    assert(ext, 'расширение QuorvoxTeam.quorvox-dev не найдено');
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['quorvox.toggle', 'quorvox.dashboard', 'quorvox.map', 'quorvox.deploy', 'quorvox.phone', 'quorvox.editorToggle']) {
      assert(cmds.includes(c), 'нет команды ' + c);
    }
    return `версия ${ext.packageJSON.version}`;
  });

  const appDoc = await vscode.workspace.openTextDocument(appUri);
  const htmlDoc = await vscode.workspace.openTextDocument(htmlUri);
  await vscode.window.showTextDocument(appDoc);

  await step('подчёркивания: адрес API, которого нет на сервере', async () => {
    const d = await waitFor(() => diagOf(appUri).find((x) => x.message.includes('/clubz')));
    assert(d, 'нет подчёркивания про /clubz; есть: ' + JSON.stringify(diagOf(appUri).map((x) => x.message)));
    assert(d.range.start.line === 2, 'не на той строке: ' + d.range.start.line);
    const text = appDoc.getText(d.range);
    assert(text.startsWith('api(') && text.includes('/clubz'), 'подчёркнут не вызов api(): «' + text + '»');
    assert(!diagOf(appUri).some((x) => x.message.includes('/clubs ')), 'верный вызов /clubs подчёркнут');
    return `«${text}», ${vscode.DiagnosticSeverity[d.severity]}`;
  });

  await step('подчёркивания: опечатка в классе подчёркивает само имя', async () => {
    const d = await waitFor(() => diagOf(htmlUri).find((x) => x.message.includes('.cardd')));
    assert(d, 'нет подчёркивания про .cardd; есть: ' + JSON.stringify(diagOf(htmlUri).map((x) => x.message)));
    assert(htmlDoc.getText(d.range) === 'cardd', 'подчёркнуто «' + htmlDoc.getText(d.range) + '»');
    assert(d.message.includes('.card'), 'нет подсказки, на что похоже');
  });

  await step('автодополнение: классы из CSS проекта в class="…"', async () => {
    const pos = htmlDoc.positionAt(htmlDoc.getText().indexOf('class=""') + 7);
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', htmlUri, pos);
    const mine = list.items.filter((i) => String(i.detail || '').startsWith('CSS ·'));
    const names = mine.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert(names.includes('card') && names.includes('btn-main'), 'нет наших классов: ' + JSON.stringify(names));
    assert(String(mine[0].detail).includes('style.css'), 'нет ссылки на файл стилей');
    return names.join(', ');
  });

  await step('автодополнение: адреса с сервера в api(\'…\'), без префикса /api, с методами', async () => {
    const pos = appDoc.positionAt(appDoc.getText().indexOf("api('')") + 5);
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', appUri, pos);
    const mine = list.items.filter((i) => String(i.detail || '').includes('server/index.js'));
    const byLabel = Object.fromEntries(mine.map((i) => [typeof i.label === 'string' ? i.label : i.label.label, i]));
    assert(byLabel['/clubs'] && byLabel['/clubs/:id/join'], 'нет адресов: ' + JSON.stringify(Object.keys(byLabel)));
    assert(String(byLabel['/clubs/:id/join'].detail).includes('POST'), 'нет метода');
    assert(!Object.keys(byLabel).some((k) => k.startsWith('/api')), 'префикс /api не отрезан');
    return Object.keys(byLabel).join(', ');
  });

  await step('Ctrl+клик: класс → правило в CSS, адрес → маршрут на сервере', async () => {
    const cardPos = htmlDoc.positionAt(htmlDoc.getText().indexOf('class="card"') + 8);
    const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', htmlUri, cardPos);
    const css = defs.find((d) => (d.targetUri || d.uri).fsPath.endsWith('style.css'));
    assert(css, 'нет перехода к style.css: ' + JSON.stringify(defs));
    assert((css.targetRange || css.range).start.line === 0, 'не на ту строку CSS');

    const apiPos = appDoc.positionAt(appDoc.getText().indexOf("api('/clubs')") + 8);
    const defs2 = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', appUri, apiPos);
    const srv = defs2.find((d) => (d.targetUri || d.uri).fsPath.endsWith('index.js'));
    assert(srv, 'нет перехода к серверу: ' + JSON.stringify(defs2));
    assert((srv.targetRange || srv.range).start.line === 2, 'не на ту строку сервера: ' + (srv.targetRange || srv.range).start.line);
  });

  await step('подсказка при наведении: кусок CSS и адрес', async () => {
    const cardPos = htmlDoc.positionAt(htmlDoc.getText().indexOf('class="card"') + 8);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', htmlUri, cardPos);
    const text = hovers.flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
    assert(text.includes('padding: 4px') && text.includes('style.css:1'), 'нет куска CSS: ' + text.slice(0, 200));
    const apiPos = appDoc.positionAt(appDoc.getText().indexOf("api('/clubs')") + 8);
    const h2 = await vscode.commands.executeCommand('vscode.executeHoverProvider', appUri, apiPos);
    const t2 = h2.flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
    assert(t2.includes('GET /api/clubs') && t2.includes('server/index.js'), 'нет адреса сервера: ' + t2.slice(0, 200));
  });

  await step('подчёркивания по НЕсохранённому тексту (пока печатаешь)', async () => {
    const editor = await vscode.window.showTextDocument(appDoc);
    const end = appDoc.lineAt(appDoc.lineCount - 1).range.end;
    await editor.edit((b) => b.insert(end, "\napi('/typed-live');\n"));
    assert(appDoc.isDirty, 'файл должен остаться несохранённым');
    const d = await waitFor(() => diagOf(appUri).find((x) => x.message.includes('typed-live')), 15000);
    assert(d, 'нет подчёркивания по набранному, но не сохранённому тексту');
    assert(!fs.readFileSync(appUri.fsPath, 'utf8').includes('typed-live'), 'на диске этого быть не должно');
    // убираем набранное: подчёркивание должно уйти само
    await editor.edit((b) => b.delete(new vscode.Range(end, appDoc.lineAt(appDoc.lineCount - 1).range.end)));
    const gone = await waitFor(() => !diagOf(appUri).some((x) => x.message.includes('typed-live')), 15000);
    assert(gone, 'подчёркивание не исчезло после удаления набранного');
  });

  await step('настройка «подчёркивание» выключает и включает', async () => {
    await cfg.update('editor.diagnostics', false, vscode.ConfigurationTarget.Global);
    const off = await waitFor(() => diagOf(appUri).length === 0 && diagOf(htmlUri).length === 0, 8000);
    assert(off, 'подчёркивания не исчезли при выключении');
    await cfg.update('editor.diagnostics', true, vscode.ConfigurationTarget.Global);
    const on = await waitFor(() => diagOf(appUri).some((x) => x.message.includes('/clubz')), 15000);
    assert(on, 'подчёркивания не вернулись при включении');
  });

  await step('настройка «автодополнение» выключает наши подсказки, hover и Ctrl+клик', async () => {
    await cfg.update('editor.completions', false, vscode.ConfigurationTarget.Global);
    await sleep(500);
    const pos = htmlDoc.positionAt(htmlDoc.getText().indexOf('class=""') + 7);
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', htmlUri, pos);
    assert(!list.items.some((i) => String(i.detail || '').startsWith('CSS ·')), 'наши классы остались при выключении');
    const cardPos = htmlDoc.positionAt(htmlDoc.getText().indexOf('class="card"') + 8);
    const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', htmlUri, cardPos);
    assert(!defs.some((d) => (d.targetUri || d.uri).fsPath.endsWith('style.css')), 'Ctrl+клик остался при выключении');
    await cfg.update('editor.completions', true, vscode.ConfigurationTarget.Global);
    await sleep(500);
    const again = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', htmlUri, pos);
    assert(again.items.some((i) => String(i.detail || '').startsWith('CSS ·')), 'классы не вернулись при включении');
  });

  // ---- перекладка: настоящая команда в настоящем редакторе ----
  const readDisk = (rel) => fs.readFileSync(at(rel).fsPath, 'utf8');
  await vscode.workspace.saveAll(false);

  await step('перекладка через WorkspaceEdit: папка css переезжает, ссылки в HTML чинятся, проверки не ухудшаются', async () => {
    const htmlBefore = readDisk('public/index.html');
    const res = await vscode.commands.executeCommand('quorvox.move', { silent: true, viaEdit: true, from: [at('public/css').fsPath], to: at('public/assets').fsPath });
    assert(res && res.ok, 'перенос не удался: ' + JSON.stringify(res && res.errors));
    assert(fs.existsSync(at('public/assets/css/style.css').fsPath), 'папка не переехала');
    assert(!fs.existsSync(at('public/css').fsPath), 'старая папка осталась');
    const html = readDisk('public/index.html');
    assert(html.includes('href="assets/css/style.css"'), 'ссылка в HTML не поправлена: ' + html.slice(0, 160));
    assert(res.after <= res.before, `замечаний стало больше: ${res.before} → ${res.after}`);
    assert(!htmlDoc.isDirty, 'документ остался несохранённым после правки');
    return `ссылок поправлено ${res.plan.edits.length}, замечаний ${res.before} → ${res.after}`;
  });

  await step('отмена переноса возвращает файлы и ссылки как были', async () => {
    const res = await vscode.commands.executeCommand('quorvox.moveUndo', { silent: true });
    assert(res && res.ok, 'откат не удался');
    assert(fs.existsSync(at('public/css/style.css').fsPath), 'папка css не вернулась');
    assert(!fs.existsSync(at('public/assets').fsPath) || fs.readdirSync(at('public/assets').fsPath).length === 0, 'в assets что-то осталось');
    assert(readDisk('public/index.html').includes('href="css/style.css"'), 'ссылка в HTML не вернулась');
  });

  await step('перекладка напрямую на диск: JS-файл переезжает, import в app.js чинится', async () => {
    const res = await vscode.commands.executeCommand('quorvox.move', { silent: true, from: [at('public/js/util.js').fsPath], to: at('public/js/lib').fsPath });
    assert(res && res.ok, 'перенос не удался: ' + JSON.stringify(res && res.errors));
    assert(readDisk('public/js/app.js').includes("from './lib/util.js'"), 'import не поправлен: ' + readDisk('public/js/app.js').slice(0, 80));
    const undo = await vscode.commands.executeCommand('quorvox.moveUndo', { silent: true });
    assert(undo && undo.ok && fs.existsSync(at('public/js/util.js').fsPath), 'откат не вернул util.js');
  });

  await step('перекладка отказывается, если файл открыт и не сохранён', async () => {
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(at('public/css/style.css')));
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '/* не сохранено */\n'));
    const res = await vscode.commands.executeCommand('quorvox.move', { silent: true, from: [at('public/css').fsPath], to: at('public/assets').fsPath });
    assert(res && !res.ok, 'перенос не должен был пройти');
    assert(fs.existsSync(at('public/css/style.css').fsPath), 'файл трогать не должны были');
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  await step('перекладка отказывается класть поверх существующего', async () => {
    const res = await vscode.commands.executeCommand('quorvox.move', { silent: true, from: [at('public/css').fsPath], to: at('public/js').fsPath, rename: 'app.js' });
    assert(res && !res.ok && res.errors.length, 'ожидалась ошибка: там уже лежит app.js');
  });

  await step('перетаскивание в проводнике (обычный перенос VS Code): ссылки чинятся сами, Ctrl+Z-подобный возврат тоже', async () => {
    const we = new vscode.WorkspaceEdit();
    we.renameFile(at('public/css'), at('public/look'), { overwrite: false });
    assert(await vscode.workspace.applyEdit(we), 'перенос не применился');
    const ok = await waitFor(() => readDisk('public/index.html').includes('href="look/style.css"'), 10000);
    assert(ok, 'ссылка в HTML не поправлена при обычном переносе: ' + readDisk('public/index.html').slice(0, 170));
    const back = new vscode.WorkspaceEdit();
    back.renameFile(at('public/look'), at('public/css'), { overwrite: false });
    assert(await vscode.workspace.applyEdit(back), 'обратный перенос не применился');
    assert(await waitFor(() => readDisk('public/index.html').includes('href="css/style.css"'), 10000), 'ссылка не вернулась при обратном переносе');
  });

  await step('команды импорта и мастера зарегистрированы', async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['quorvox.import', 'quorvox.onboard', 'quorvox.move', 'quorvox.moveUndo']) assert(cmds.includes(c), 'нет команды ' + c);
  });

  await step('язык: переключение на English меняет сообщения проверок, обратно на Русский — возвращает', async () => {
    await cfg.update('language', 'en', vscode.ConfigurationTarget.Global);
    const en = await waitFor(() => diagOf(appUri).find((x) => x.message.includes('/clubz') && x.message.includes('front end')), 15000);
    assert(en, 'сообщение не стало английским: ' + JSON.stringify(diagOf(appUri).map((x) => x.message)));
    await cfg.update('language', 'ru', vscode.ConfigurationTarget.Global);
    const ru = await waitFor(() => diagOf(appUri).find((x) => x.message.includes('/clubz') && x.message.includes('Фронт')), 15000);
    assert(ru, 'сообщение не вернулось на русский');
    await cfg.update('language', undefined, vscode.ConfigurationTarget.Global);
    const cmds = await vscode.commands.getCommands(true);
    assert(cmds.includes('quorvox.language'), 'нет команды смены языка');
  });

  const failed = steps.filter((s) => !s.ok);
  fs.writeFileSync(process.env.QV_RESULT, JSON.stringify({ ok: failed.length === 0, steps }, null, 2), 'utf8');
  if (failed.length) throw new Error(`${failed.length} шагов не прошли`);
}

module.exports = { run };
