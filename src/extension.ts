import * as vscode from 'vscode';
import { join } from 'node:path';
import { detectServices } from './detect.ts';
import { Stack } from './stack.ts';
import { LogBuffer } from './logbuf.ts';
import { snapshot, checksView } from './model.ts';
import { ServicesTree, ChecksTree } from './tree.ts';
import { Dashboard } from './dashboard.ts';
import type { ReleaseInfo } from './dashboard.ts';
import { analyzeProject } from './checks.ts';
import { MapPanel } from './mappanel.ts';
import { registerEditor } from './editor.ts';
import { qrSvg } from './qr.ts';
import { readDeployConfig, planFiles, findSecrets, deployRelease, rollbackRelease, confirmRelease, describePlan, realRun } from './deploy.ts';
import { buildEnvExample } from './envfile.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Report } from './checks.ts';
import type { ServiceRunner } from './runner.ts';

let stack: Stack | null = null;
let out: vscode.OutputChannel;
let bar: vscode.StatusBarItem;
let tree: ServicesTree;
let checksTree: ChecksTree;
// null — если окно ещё не знает про этот вид (после обновления расширения без Reload Window)
let checksView_: vscode.TreeView<unknown> | null = null;
let dash: Dashboard;
let mapPanel: MapPanel;
let editor: { publish(): void } | null = null;
let report: Report | null = null;
let checkTimer: ReturnType<typeof setTimeout> | undefined;
const buf = new LogBuffer();

function root(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('quorvox').get<T>(key, fallback);
}

// число замечаний проверок (без «info») — показываем в строке статуса
function issueCount(): number {
  return report ? report.findings.filter((f) => f.severity !== 'info').length : 0;
}

function updateBar() {
  const n = stack?.runners.length ?? 0;
  const issues = issueCount();
  const tail = issues ? ` $(warning) ${issues}` : '';
  bar.backgroundColor = undefined;
  if (!stack || n === 0) {
    bar.text = '$(circle-slash) Quorvox' + tail;
    bar.tooltip = 'В этой папке нет проекта для запуска: нужен package.json со скриптом dev/start, index.html (запущу как сайт) или quorvox.json';
  } else if (stack.anyCrashed()) {
    bar.text = '$(error) Quorvox' + tail;
    bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    bar.tooltip = 'Что-то упало. Клик — остановить всё';
  } else if (stack.anyRunning()) {
    const run = stack.runners.filter((r) => r.status === 'running').length;
    bar.text = `$(debug-stop) Quorvox ${run}/${n}` + tail;
    bar.tooltip = 'Клик — остановить всё';
  } else {
    bar.text = '$(play) Quorvox' + tail;
    bar.tooltip = `Запустить сервисы: ${stack.runners.map((r) => r.def.name).join(', ')}`;
  }
  if (issues) bar.tooltip += `\nПроверки: ${issues} замечаний (смотри панель Quorvox → Проверки)`;
  bar.show();
}

// проверки читают только файлы, на проекте в сотню файлов это десятки миллисекунд
const CODE_FILE = /\.(m?js|cjs|ts|html?|css)$/i;
let lastCheckMs = 0;

// текст файлов, которые открыты и ещё не сохранены: проверки должны видеть то, что человек набрал сейчас
function dirtyOverrides(): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty && d.uri.scheme === 'file' && CODE_FILE.test(d.fileName)) m.set(d.uri.fsPath.toLowerCase(), d.getText());
  }
  return m;
}

// typing: запуск из-за набора текста (карту при этом не перестраиваем, чтобы не мигала)
function runChecks(typing = false) {
  const dir = root();
  const t0 = Date.now();
  try {
    report = dir ? analyzeProject(dir, (stack?.runners ?? []).map((r) => ({ name: r.def.name, cwd: r.def.cwd })), dirtyOverrides()) : null;
  } catch (e) {
    report = null;
    out.appendLine(`[quorvox] проверки не отработали: ${(e as Error).message}`);
  }
  lastCheckMs = Date.now() - t0;
  checksTree.set(report);
  if (checksView_) checksView_.description = report ? `маршрутов ${report.stats.routes} · запросов ${report.stats.calls}` : '';
  refresh();
  editor?.publish();
  if (!typing && mapPanel.isOpen()) mapPanel.send();
}

function scheduleChecks() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => runChecks(), 1500);
}

// пока человек печатает: ждём паузу, на больших проектах дольше (анализ тяжелее)
function scheduleTyping() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => runChecks(true), Math.max(800, lastCheckMs * 4));
}

async function editorToggle() {
  const c = vscode.workspace.getConfiguration('quorvox');
  const items = [
    { label: 'Подчёркивание ошибок в коде', description: 'адрес API, имя класса, ссылка на файл', key: 'editor.diagnostics', picked: c.get('editor.diagnostics', true) },
    { label: 'Автодополнение, переход к определению, подсказки', description: 'классы из CSS, адреса API, переменные .env', key: 'editor.completions', picked: c.get('editor.completions', true) },
  ];
  const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Что включить в редакторе (галочка — включено)' });
  if (!picks) return;
  const on = new Set(picks.map((p) => p.key));
  for (const it of items) await c.update(it.key, on.has(it.key), vscode.ConfigurationTarget.Global);
  runChecks();
}

async function openFinding(file: string, line: number) {
  const dir = root();
  if (!dir || !file) return;
  const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  await vscode.window.showTextDocument(vscode.Uri.file(join(dir, file)), { selection: new vscode.Range(pos, pos) });
}

// одно место, откуда обновляются все панели
function refresh() {
  updateBar();
  const views = snapshot(stack, root());
  tree.set(views);
  void vscode.commands.executeCommand('setContext', 'quorvox.noServices', views.length === 0);
  dash.update();
}

async function rebuild() {
  await stack?.stopAll();
  const dir = root();
  stack = dir ? new Stack(detectServices(dir)) : null;
  stack?.on('log', (name: string, line: string) => {
    const l = buf.push(name, line);
    out.appendLine(`[${name}] ${l.text}`);
    dash.log(l);
  });
  stack?.on('status', refresh);
  scheduleChecks();
  stack?.on('proxy', (name: string, url: string) => {
    refresh();
    void vscode.window
      .showInformationMessage(`${name}: открой ${url} — страница будет обновляться сама`, 'Открыть в браузере')
      .then((pick) => {
        if (pick) void vscode.env.openExternal(vscode.Uri.parse(url));
      });
  });
  refresh();
}

function find(name?: string): ServiceRunner | undefined {
  return stack?.runners.find((r) => r.def.name === name);
}

// сервис берём из аргумента (клик по кнопке в дереве), а если вызвали из палитры — спрашиваем
async function pickRunner(arg?: { name?: string }): Promise<ServiceRunner | undefined> {
  if (!stack || stack.runners.length === 0) return undefined;
  const byArg = find(arg?.name);
  if (byArg) return byArg;
  if (stack.runners.length === 1) return stack.runners[0];
  const pick = await vscode.window.showQuickPick(
    stack.runners.map((r) => ({ label: r.def.name, description: r.status, r })),
    { placeHolder: 'Какой сервис?' },
  );
  return pick?.r;
}

async function openUrl(r?: ServiceRunner) {
  const url = r?.proxy?.port ? `http://localhost:${r.proxy.port}` : null;
  if (!url) {
    vscode.window.showInformationMessage('Адреса пока нет: запусти сервис и дождись, пока он напишет свой порт.');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function openBrowser() {
  const list = stack?.urls() ?? [];
  if (list.length === 0) {
    vscode.window.showInformationMessage('Адреса пока нет: запусти сервисы (▶) и дождись, пока сервер напишет свой порт.');
    return;
  }
  let url = list[0].url;
  if (list.length > 1) {
    const pick = await vscode.window.showQuickPick(
      list.map((x) => ({ label: x.name, description: x.url, url: x.url })),
      { placeHolder: 'Что открыть?' },
    );
    if (!pick) return;
    url = pick.url;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

// Телефон: открываем доступ к сервису из локальной сети и показываем QR. Только после явного «да».
async function phoneOn(arg?: { name?: string }) {
  const live = stack?.runners.filter((r) => r.proxy?.port) ?? [];
  let r = live.find((x) => x.def.name === arg?.name);
  if (!r && live.length === 1) r = live[0];
  if (!r && live.length > 1) {
    const pick = await vscode.window.showQuickPick(
      live.map((x) => ({ label: x.def.name, r: x })),
      { placeHolder: 'Какой сервис открыть на телефоне?' },
    );
    r = pick?.r;
  }
  if (!r) {
    if (live.length === 0) {
      vscode.window.showInformationMessage('Сначала запусти сервис и дождись, пока он напишет свой порт (появится адрес с автообновлением).');
    }
    return;
  }
  if (!r.proxy?.lanUrl()) {
    const ok = await vscode.window.showWarningMessage(
      `Открыть доступ к «${r.def.name}» для устройств в вашей Wi-Fi сети?`,
      {
        modal: true,
        detail:
          'Пока доступ включён, любой человек в вашей локальной сети сможет открыть этот проект. Выключить можно в любой момент; при остановке сервисов он выключится сам.',
      },
      'Открыть доступ',
    );
    if (ok !== 'Открыть доступ') return;
  }
  const url = await stack!.phoneOn(r.def.name);
  if (!url) {
    vscode.window.showErrorMessage('Не нашёл адрес компьютера в локальной сети. Подключись к Wi-Fi или кабелю и попробуй ещё раз.');
    return;
  }
  out.appendLine(`[quorvox] телефон: ${r.def.name} открыт по ${url} (только для частных сетей)`);
  dash.show();
  // окно дашборда могло только что открыться: даём ему загрузиться
  const info = { name: r.def.name, url, svg: qrSvg(url) };
  dash.qr(info);
  setTimeout(() => dash.qr(info), 700);
}

function phoneOff(name?: string) {
  const r = stack?.runners.find((x) => x.def.name === name) ?? stack?.runners.find((x) => x.proxy?.lanUrl());
  if (!r) return;
  stack!.phoneOff(r.def.name);
  dash.qr(null);
  out.appendLine(`[quorvox] телефон: доступ к ${r.def.name} из сети выключен`);
}

// ---------- деплой на VPS ----------

let extCtx: vscode.ExtensionContext;
const PENDING_KEY = 'quorvox.pendingRelease';

function getPending(): ReleaseInfo | null {
  return extCtx?.workspaceState.get<ReleaseInfo>(PENDING_KEY) ?? null;
}

function setPending(p: ReleaseInfo | null) {
  void extCtx.workspaceState.update(PENDING_KEY, p ?? undefined);
  dash.showRelease(p);
}

function logDeploy(line: string) {
  const l = buf.push('deploy', line);
  out.appendLine(`[deploy] ${l.text}`);
  dash.log(l);
}

// Шаблон настроек деплоя в quorvox.json: host пустой, поэтому без заполнения ничего не отправится
async function createDeployTemplate(dir: string) {
  const file = join(dir, 'quorvox.json');
  let json: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      vscode.window.showErrorMessage('quorvox.json не читается (ошибка в JSON). Поправь файл и повтори.');
      return;
    }
  }
  json.deploy = {
    host: '',
    user: 'root',
    path: '/opt/my-project',
    restart: 'pm2 restart my-project',
    install: 'npm ci --omit=dev',
    check: 'curl -fsS -o /dev/null http://127.0.0.1:3000/',
  };
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage(
    'Заполни host, path, restart и check под свой сервер и снова нажми «Выложить». Вход только по ключу ssh, пароли тут не нужны и не хранятся.',
  );
}

async function deploy() {
  const dir = root();
  if (!dir) return;
  const { config, problems } = readDeployConfig(dir);
  if (problems.length) {
    vscode.window.showErrorMessage('quorvox.json → deploy: ' + problems.join('; '));
    return;
  }
  if (!config) {
    const pick = await vscode.window.showInformationMessage('Деплой ещё не настроен. Создать шаблон настроек в quorvox.json?', 'Создать шаблон');
    if (pick) await createDeployTemplate(dir);
    return;
  }

  // 1. локальные проверки: красные ошибки — повод остановиться
  runChecks();
  const errors = report?.findings.filter((f) => f.severity === 'error') ?? [];
  if (errors.length) {
    const go = await vscode.window.showWarningMessage(
      `В проверках проекта ${errors.length} ошибок. Выкладывать с ними?`,
      { modal: true, detail: errors.slice(0, 6).map((f) => '• ' + f.message).join('\n') },
      'Всё равно выложить',
    );
    if (go !== 'Всё равно выложить') return;
  }

  // 2. что поедет на сервер
  const plan = planFiles(dir, config);
  if (plan.tooBig) {
    vscode.window.showErrorMessage(`Слишком много для выкладки (${plan.tooBig}). Добавь лишнее в deploy.exclude в quorvox.json.`);
    return;
  }
  const secrets = findSecrets(dir, plan.files);
  const skipped = [...new Set(plan.skipped.map((s) => s.why))].slice(0, 8).join('; ');
  const detail = [
    ...describePlan(config, plan),
    '',
    `Не уйдёт на сервер: ${skipped || 'ничего лишнего не нашёл'}.`,
    ...(secrets.length ? ['', '⚠ В отправляемых файлах похоже на секреты: ' + secrets.map((s) => `${s.file} (${s.kind})`).join(', ') + '. Лучше убрать их в .env.'] : []),
    ...(plan.warnings.length ? ['', ...plan.warnings] : []),
  ].join('\n');
  const goLabel = secrets.length ? 'Выложить, несмотря на секреты' : 'Выложить';
  const choice = await vscode.window.showWarningMessage(`Выложить проект на ${config.user}@${config.host}?`, { modal: true, detail }, goLabel, 'Сухой прогон');
  if (!choice) return;

  dash.show();
  if (choice === 'Сухой прогон') {
    logDeploy('— сухой прогон: ничего не отправляется —');
    for (const l of describePlan(config, plan)) logDeploy(l);
    logDeploy('Файлы (первые 40): ' + plan.files.slice(0, 40).join(', ') + (plan.files.length > 40 ? ` … и ещё ${plan.files.length - 40}` : ''));
    for (const s of plan.skipped.slice(0, 25)) logDeploy(`не отправлю: ${s.what} (${s.why})`);
    return;
  }

  // 3. выкладка
  const push = (create: boolean) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Quorvox: выкладываю на сервер…' }, () =>
      deployRelease(dir, config, plan.files, { run: realRun, log: logDeploy }, { create }),
    );
  let res = await push(false);
  if (res.noDir) {
    // первая выкладка: папки на сервере ещё нет. Создаём только после отдельного «да»
    const mk = await vscode.window.showWarningMessage(
      res.message,
      { modal: true, detail: `Создам папку ${config.path} на ${config.host} и выложу туда проект. Больше ничего на сервере не меняется, кроме команд из quorvox.json (${[config.install, config.restart, config.check].filter(Boolean).join('; ') || 'их нет'}).` },
      'Создать папку и выложить',
    );
    if (mk !== 'Создать папку и выложить') return;
    res = await push(true);
  }
  logDeploy(res.ok ? `✔ ${res.message}` : `✖ ${res.message}`);
  if (res.ok) {
    if (res.hasBackup && res.backup) {
      // старая версия лежит копией на сервере; решение за человеком, оно запоминается (плашка на дашборде)
      setPending({ host: config.host, ts: res.backup, at: Date.now() });
      const pick = await vscode.window.showInformationMessage(
        `Выложено и проверено на ${config.host}. Старая версия сохранена на сервере. Всё работает?`,
        'Работает, удалить копию',
        'Откатить',
      );
      if (pick === 'Работает, удалить копию') await releaseOk();
      else if (pick === 'Откатить') await rollback(res.backup);
    } else {
      vscode.window.showInformationMessage(`Выложено и проверено на ${config.host}. Это первая выкладка: старой версии не было, откатывать некуда.`);
    }
    return;
  }
  const canRollback = !!res.backup && ['install', 'restart', 'check'].includes(res.failedAt ?? '');
  const pick = await vscode.window.showErrorMessage(res.message, ...(canRollback ? ['Откатить на прошлую версию'] : []));
  if (pick) await rollback(res.backup);
}

// «Работает»: удаляем на сервере копию старой версии именно этой выкладки
async function releaseOk() {
  const dir = root();
  const p = getPending();
  if (!dir || !p) {
    vscode.window.showInformationMessage('Нет выкладки, которая ждёт подтверждения.');
    return;
  }
  const { config } = readDeployConfig(dir);
  if (!config) {
    vscode.window.showErrorMessage('Деплой не настроен в quorvox.json.');
    return;
  }
  dash.show();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Quorvox: удаляю копию старой версии…' }, () =>
    confirmRelease(config, p.ts, { run: realRun, log: logDeploy }),
  );
  logDeploy(res.ok ? `✔ ${res.message}` : `✖ ${res.message}`);
  if (res.ok) {
    setPending(null);
    vscode.window.showInformationMessage(res.message);
  } else {
    vscode.window.showErrorMessage(res.message);
  }
}

// ts — откатить именно на эту копию (нажали «Откатить» у выкладки: окно подтверждения не нужно, решение уже принято)
async function rollback(ts?: string) {
  const dir = root();
  if (!dir) return;
  const { config, problems } = readDeployConfig(dir);
  if (!config) {
    vscode.window.showErrorMessage(problems.length ? 'quorvox.json → deploy: ' + problems.join('; ') : 'Деплой не настроен в quorvox.json.');
    return;
  }
  const target = ts ?? getPending()?.ts;
  if (!ts) {
    const ok = await vscode.window.showWarningMessage(
      `Откатить ${config.host}:${config.path} на ${target ? 'копию последней выкладки' : 'последнюю сохранённую копию'}?`,
      { modal: true, detail: 'Файлы из копии вернутся на место, потом выполнится перезапуск и проверка. Новые файлы, которых не было в копии, останутся на сервере.' },
      'Откатить',
    );
    if (ok !== 'Откатить') return;
  }
  dash.show();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Quorvox: откатываю…' }, () =>
    rollbackRelease(config, { run: realRun, log: logDeploy }, target),
  );
  logDeploy(res.ok ? `✔ ${res.message}` : `✖ ${res.message}`);
  if (res.ok) {
    if (target && getPending()?.ts === target) setPending(null);
    vscode.window.showInformationMessage(res.message);
  } else {
    vscode.window.showErrorMessage(res.message);
  }
}

async function envExample() {
  const dir = root();
  if (!dir) return;
  const r = buildEnvExample(dir);
  if (!r.added.length) {
    vscode.window.showInformationMessage(r.existing ? '.env.example уже содержит все переменные из кода.' : 'В серверном коде не нашёл переменных окружения.');
    return;
  }
  const file = join(dir, '.env.example');
  writeFileSync(file, r.text, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage(`${r.existing ? 'Дописал в' : 'Создал'} .env.example: ${r.added.length} переменных (только имена, без значений).`);
  runChecks();
}

function startAll() {
  if (!stack || stack.runners.length === 0) {
    vscode.window.showInformationMessage(
      'В этой папке нет проекта для запуска. Подойдёт: package.json со скриптом dev или start, index.html (запущу как сайт) или quorvox.json. Для не-веб-папки это нормально.',
    );
    return;
  }
  if (cfg('showDashboardOnStart', true)) dash.show();
  stack.startAll();
}

async function toggle() {
  if (stack?.anyRunning() || stack?.anyCrashed()) await stack.stopAll();
  else startAll();
}

// команды с дашборда
async function fromDashboard(msg: { cmd: string; name?: string; file?: string; line?: number }) {
  const r = find(msg.name);
  switch (msg.cmd) {
    case 'map':
      return mapPanel.show();
    case 'deploy':
      return deploy();
    case 'releaseOk':
      return releaseOk();
    case 'releaseUndo':
      return rollback(getPending()?.ts);
    case 'phone':
      return phoneOn({ name: msg.name });
    case 'phoneOff':
      return phoneOff(msg.name);
    case 'openFinding':
      return openFinding(msg.file ?? '', msg.line ?? 1);
    case 'recheck':
      return runChecks();
    case 'startAll':
      return startAll();
    case 'stopAll':
      return void (await stack?.stopAll());
    case 'start':
      return r?.start();
    case 'stop':
      return void (await r?.stop());
    case 'restart':
      return void (await r?.restart());
    case 'open':
      return openUrl(r);
    case 'clear':
      return buf.clear();
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  extCtx = ctx;
  out = vscode.window.createOutputChannel('Quorvox Dev');
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = 'quorvox.toggle';
  tree = new ServicesTree();
  checksTree = new ChecksTree();
  try {
    checksView_ = vscode.window.createTreeView('quorvox.checks', { treeDataProvider: checksTree });
  } catch {
    // окно подхватило новый код, но не новые панели — пока не сделан Reload Window, живём без этого вида
    out.appendLine('[quorvox] вид «Проверки» не зарегистрирован: перезагрузи окно (Developer: Reload Window)');
  }
  mapPanel = new MapPanel({ root, openFile: (file, line) => void openFinding(file, line) });
  editor = registerEditor(ctx, {
    root,
    report: () => report,
    enabled: (f) => cfg(f === 'diagnostics' ? 'editor.diagnostics' : 'editor.completions', true),
  });
  dash = new Dashboard({
    release: getPending,
    services: () => snapshot(stack, root()),
    checks: () => checksView(report),
    history: () => buf.all(),
    command: (m) => void fromDashboard(m),
  });

  ctx.subscriptions.push(
    out,
    bar,
    { dispose: () => dash.dispose() },
    vscode.window.createTreeView('quorvox.services', { treeDataProvider: tree }),
    { dispose: () => checksView_?.dispose() },
    { dispose: () => mapPanel.dispose() },
    { dispose: () => clearTimeout(checkTimer) },
    vscode.commands.registerCommand('quorvox.map', () => mapPanel.show()),
    vscode.commands.registerCommand('quorvox.editorToggle', editorToggle),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0 || !CODE_FILE.test(e.document.fileName)) return;
      if (!cfg('editor.diagnostics', true) && !cfg('editor.completions', true)) return;
      scheduleTyping();
    }),
    vscode.commands.registerCommand('quorvox.deploy', deploy),
    vscode.commands.registerCommand('quorvox.rollback', () => rollback()),
    vscode.commands.registerCommand('quorvox.releaseOk', releaseOk),
    vscode.commands.registerCommand('quorvox.envExample', envExample),
    vscode.commands.registerCommand('quorvox.phone', (a?: { name?: string }) => phoneOn(a)),
    vscode.commands.registerCommand('quorvox.phoneOff', (a?: { name?: string }) => phoneOff(a?.name)),
    vscode.commands.registerCommand('quorvox.check', runChecks),
    vscode.commands.registerCommand('quorvox.openFinding', openFinding),
    vscode.commands.registerCommand('quorvox.toggle', toggle),
    vscode.commands.registerCommand('quorvox.dashboard', (arg?: unknown) =>
      dash.show(typeof arg === 'string' ? arg : undefined),
    ),
    vscode.commands.registerCommand('quorvox.showLogs', () => out.show(true)),
    vscode.commands.registerCommand('quorvox.open', openBrowser),
    vscode.commands.registerCommand('quorvox.rescan', rebuild),
    vscode.commands.registerCommand('quorvox.service.start', async (a?: { name?: string }) => (await pickRunner(a))?.start()),
    vscode.commands.registerCommand('quorvox.service.stop', async (a?: { name?: string }) => void (await (await pickRunner(a))?.stop())),
    vscode.commands.registerCommand('quorvox.service.restart', async (a?: { name?: string }) => void (await (await pickRunner(a))?.restart())),
    vscode.commands.registerCommand('quorvox.service.open', async (a?: { name?: string }) => openUrl(await pickRunner(a))),
  );

  // следим за диском, а не за Ctrl+S: ИИ-агент, git pull и другие программы тоже меняют файлы
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const files = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/{*.js,*.mjs,*.cjs,*.ts,*.json,*.html,*.htm,*.css,*.svg,.env,.env.*}'),
    );
    const onFile = (uri: vscode.Uri) => {
      scheduleChecks();
      if (!cfg('autoRestart', true)) return;
      stack?.fileSaved(uri.fsPath);
    };
    files.onDidChange(onFile);
    files.onDidCreate(onFile);
    ctx.subscriptions.push(files);
  }

  // package.json / quorvox.json поменялись — пересканируем, но только если ничего не запущено
  const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,quorvox.json}');
  const onChange = () => {
    if (!stack?.anyRunning()) void rebuild();
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  ctx.subscriptions.push(watcher);

  await rebuild();
}

export async function deactivate() {
  await stack?.stopAll();
}
