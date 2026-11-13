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
import { registerMove } from './movecmd.ts';
import { registerImport } from './importcmd.ts';
import { setLang, resolveLang } from './i18n.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Report } from './checks.ts';
import type { ServiceRunner } from './runner.ts';
import { tr } from './i18n.ts';

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

// В папке без доверия запускать нельзя ничего: проект запускает чужой код (npm-скрипты, сервер).
// Читать файлы, проверки, карта и подсказки в редакторе работают и так.
function requireTrust(what: string): boolean {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window
    .showWarningMessage(tr('Папка не отмечена как доверенная, поэтому {0} не буду: проект запускает код, а чужой код может навредить. Если проект твой или ты его проверил — доверься папке.', what), tr('Управление доверием'))
    .then((p) => {
      if (p) void vscode.commands.executeCommand('workbench.trust.manage');
    });
  return false;
}

// язык интерфейса: «auto» — по языку VS Code (русский → русский, всё остальное → английский)
function applyLanguage(redraw: boolean) {
  setLang(resolveLang(vscode.workspace.getConfiguration('quorvox').get<string>('language', 'auto'), vscode.env.language));
  if (!redraw) return;
  dash?.relocalize();
  mapPanel?.relocalize();
  runChecks();
}

async function pickLanguage() {
  const cur = vscode.workspace.getConfiguration('quorvox').get<string>('language', 'auto');
  const items = [
    { label: 'Auto', description: 'по языку VS Code / by VS Code language', value: 'auto' },
    { label: 'Русский', description: '', value: 'ru' },
    { label: 'English', description: '', value: 'en' },
  ].map((i) => ({ ...i, picked: i.value === cur, description: i.value === cur ? i.description + ' ✓' : i.description }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Language / Язык' });
  if (pick) await vscode.workspace.getConfiguration('quorvox').update('language', pick.value, vscode.ConfigurationTarget.Global);
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
    bar.tooltip = tr('В этой папке нет проекта для запуска: нужен package.json со скриптом dev/start, index.html (запущу как сайт) или quorvox.json');
  } else if (stack.anyCrashed()) {
    bar.text = '$(error) Quorvox' + tail;
    bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    bar.tooltip = tr('Что-то упало. Клик — остановить всё');
  } else if (stack.anyRunning()) {
    const run = stack.runners.filter((r) => r.status === 'running').length;
    bar.text = `$(debug-stop) Quorvox ${run}/${n}` + tail;
    bar.tooltip = tr('Клик — остановить всё');
  } else {
    bar.text = '$(play) Quorvox' + tail;
    bar.tooltip = tr('Запустить сервисы: {0}', stack.runners.map((r) => r.def.name).join(', '));
  }
  if (issues) bar.tooltip += tr('\nПроверки: {0} замечаний (смотри панель Quorvox → Проверки)', issues);
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
    out.appendLine(tr('[quorvox] проверки не отработали: {0}', (e as Error).message));
  }
  lastCheckMs = Date.now() - t0;
  checksTree.set(report);
  if (checksView_) checksView_.description = report ? tr('маршрутов {0} · запросов {1}', report.stats.routes, report.stats.calls) : '';
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
    { label: tr('Подчёркивание ошибок в коде'), description: tr('адрес API, имя класса, ссылка на файл'), key: 'editor.diagnostics', picked: c.get('editor.diagnostics', true) },
    { label: tr('Автодополнение, переход к определению, подсказки'), description: tr('классы из CSS, адреса API, переменные .env'), key: 'editor.completions', picked: c.get('editor.completions', true) },
  ];
  const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: tr('Что включить в редакторе (галочка — включено)') });
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
      .showInformationMessage(tr('{0}: открой {1} — страница будет обновляться сама', name, url), tr('Открыть в браузере'))
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
    { placeHolder: tr('Какой сервис?') },
  );
  return pick?.r;
}

async function openUrl(r?: ServiceRunner) {
  const url = r?.proxy?.port ? `http://localhost:${r.proxy.port}` : null;
  if (!url) {
    vscode.window.showInformationMessage(tr('Адреса пока нет: запусти сервис и дождись, пока он напишет свой порт.'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function openBrowser() {
  const list = stack?.urls() ?? [];
  if (list.length === 0) {
    vscode.window.showInformationMessage(tr('Адреса пока нет: запусти сервисы (▶) и дождись, пока сервер напишет свой порт.'));
    return;
  }
  let url = list[0].url;
  if (list.length > 1) {
    const pick = await vscode.window.showQuickPick(
      list.map((x) => ({ label: x.name, description: x.url, url: x.url })),
      { placeHolder: tr('Что открыть?') },
    );
    if (!pick) return;
    url = pick.url;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

// Телефон: открываем доступ к сервису из локальной сети и показываем QR. Только после явного «да».
async function phoneOn(arg?: { name?: string }) {
  if (!requireTrust(tr('открывать доступ с телефона'))) return;
  const live = stack?.runners.filter((r) => r.proxy?.port) ?? [];
  let r = live.find((x) => x.def.name === arg?.name);
  if (!r && live.length === 1) r = live[0];
  if (!r && live.length > 1) {
    const pick = await vscode.window.showQuickPick(
      live.map((x) => ({ label: x.def.name, r: x })),
      { placeHolder: tr('Какой сервис открыть на телефоне?') },
    );
    r = pick?.r;
  }
  if (!r) {
    if (live.length === 0) {
      vscode.window.showInformationMessage(tr('Сначала запусти сервис и дождись, пока он напишет свой порт (появится адрес с автообновлением).'));
    }
    return;
  }
  if (!r.proxy?.lanUrl()) {
    const ok = await vscode.window.showWarningMessage(
      tr('Открыть доступ к «{0}» для устройств в вашей Wi-Fi сети?', r.def.name),
      {
        modal: true,
        detail:
          tr('Пока доступ включён, любой человек в вашей локальной сети сможет открыть этот проект. Выключить можно в любой момент; при остановке сервисов он выключится сам.'),
      },
      tr('Открыть доступ'),
    );
    if (ok !== tr('Открыть доступ')) return;
  }
  const url = await stack!.phoneOn(r.def.name);
  if (!url) {
    vscode.window.showErrorMessage(tr('Не нашёл адрес компьютера в локальной сети. Подключись к Wi-Fi или кабелю и попробуй ещё раз.'));
    return;
  }
  out.appendLine(tr('[quorvox] телефон: {0} открыт по {1} (только для частных сетей)', r.def.name, url));
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
  out.appendLine(tr('[quorvox] телефон: доступ к {0} из сети выключен', r.def.name));
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
      vscode.window.showErrorMessage(tr('quorvox.json не читается (ошибка в JSON). Поправь файл и повтори.'));
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
    tr('Заполни host, path, restart и check под свой сервер и снова нажми «Выложить». Вход только по ключу ssh, пароли тут не нужны и не хранятся.'),
  );
}

async function deploy() {
  const dir = root();
  if (!dir) return;
  if (!requireTrust(tr('выкладывать на сервер'))) return;
  const { config, problems } = readDeployConfig(dir);
  if (problems.length) {
    vscode.window.showErrorMessage('quorvox.json → deploy: ' + problems.join('; '));
    return;
  }
  if (!config) {
    const pick = await vscode.window.showInformationMessage(tr('Деплой ещё не настроен. Создать шаблон настроек в quorvox.json?'), tr('Создать шаблон'));
    if (pick) await createDeployTemplate(dir);
    return;
  }

  // 1. локальные проверки: красные ошибки — повод остановиться
  runChecks();
  const errors = report?.findings.filter((f) => f.severity === 'error') ?? [];
  if (errors.length) {
    const go = await vscode.window.showWarningMessage(
      tr('В проверках проекта {0} ошибок. Выкладывать с ними?', errors.length),
      { modal: true, detail: errors.slice(0, 6).map((f) => '• ' + f.message).join('\n') },
      tr('Всё равно выложить'),
    );
    if (go !== tr('Всё равно выложить')) return;
  }

  // 2. что поедет на сервер
  const plan = planFiles(dir, config);
  if (plan.tooBig) {
    vscode.window.showErrorMessage(tr('Слишком много для выкладки ({0}). Добавь лишнее в deploy.exclude в quorvox.json.', plan.tooBig));
    return;
  }
  const secrets = findSecrets(dir, plan.files);
  const skipped = [...new Set(plan.skipped.map((s) => s.why))].slice(0, 8).join('; ');
  const detail = [
    ...describePlan(config, plan),
    '',
    tr('Не уйдёт на сервер: {0}.', skipped || tr('ничего лишнего не нашёл')),
    ...(secrets.length ? ['', tr('⚠ В отправляемых файлах похоже на секреты: ') + secrets.map((s) => `${s.file} (${s.kind})`).join(', ') + tr('. Лучше убрать их в .env.')] : []),
    ...(plan.warnings.length ? ['', ...plan.warnings] : []),
  ].join('\n');
  const goLabel = secrets.length ? tr('Выложить, несмотря на секреты') : tr('Выложить');
  const choice = await vscode.window.showWarningMessage(tr('Выложить проект на {0}@{1}?', config.user, config.host), { modal: true, detail }, goLabel, tr('Сухой прогон'));
  if (!choice) return;

  dash.show();
  if (choice === tr('Сухой прогон')) {
    logDeploy(tr('— сухой прогон: ничего не отправляется —'));
    for (const l of describePlan(config, plan)) logDeploy(l);
    logDeploy(tr('Файлы (первые 40): ') + plan.files.slice(0, 40).join(', ') + (plan.files.length > 40 ? tr(' … и ещё {0}', plan.files.length - 40) : ''));
    for (const s of plan.skipped.slice(0, 25)) logDeploy(tr('не отправлю: {0} ({1})', s.what, s.why));
    return;
  }

  // 3. выкладка
  const push = (create: boolean) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Quorvox: выкладываю на сервер…') }, () =>
      deployRelease(dir, config, plan.files, { run: realRun, log: logDeploy }, { create }),
    );
  let res = await push(false);
  if (res.noDir) {
    // первая выкладка: папки на сервере ещё нет. Создаём только после отдельного «да»
    const mk = await vscode.window.showWarningMessage(
      res.message,
      { modal: true, detail: tr('Создам папку {0} на {1} и выложу туда проект. Больше ничего на сервере не меняется, кроме команд из quorvox.json ({2}).', config.path, config.host, [config.install, config.restart, config.check].filter(Boolean).join('; ') || tr('их нет')) },
      tr('Создать папку и выложить'),
    );
    if (mk !== tr('Создать папку и выложить')) return;
    res = await push(true);
  }
  logDeploy(res.ok ? `✔ ${res.message}` : `✖ ${res.message}`);
  if (res.ok) {
    if (res.hasBackup && res.backup) {
      // старая версия лежит копией на сервере; решение за человеком, оно запоминается (плашка на дашборде)
      setPending({ host: config.host, ts: res.backup, at: Date.now() });
      const pick = await vscode.window.showInformationMessage(
        tr('Выложено и проверено на {0}. Старая версия сохранена на сервере. Всё работает?', config.host),
        tr('Работает, удалить копию'),
        tr('Откатить'),
      );
      if (pick === tr('Работает, удалить копию')) await releaseOk();
      else if (pick === tr('Откатить')) await rollback(res.backup);
    } else {
      vscode.window.showInformationMessage(tr('Выложено и проверено на {0}. Это первая выкладка: старой версии не было, откатывать некуда.', config.host));
    }
    return;
  }
  const canRollback = !!res.backup && ['install', 'restart', 'check'].includes(res.failedAt ?? '');
  const pick = await vscode.window.showErrorMessage(res.message, ...(canRollback ? [tr('Откатить на прошлую версию')] : []));
  if (pick) await rollback(res.backup);
}

// «Работает»: удаляем на сервере копию старой версии именно этой выкладки
async function releaseOk() {
  const dir = root();
  const p = getPending();
  if (!dir || !p) {
    vscode.window.showInformationMessage(tr('Нет выкладки, которая ждёт подтверждения.'));
    return;
  }
  const { config } = readDeployConfig(dir);
  if (!config) {
    vscode.window.showErrorMessage(tr('Деплой не настроен в quorvox.json.'));
    return;
  }
  dash.show();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Quorvox: удаляю копию старой версии…') }, () =>
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
  if (!requireTrust(tr('откатывать сервер'))) return;
  const { config, problems } = readDeployConfig(dir);
  if (!config) {
    vscode.window.showErrorMessage(problems.length ? 'quorvox.json → deploy: ' + problems.join('; ') : tr('Деплой не настроен в quorvox.json.'));
    return;
  }
  const target = ts ?? getPending()?.ts;
  if (!ts) {
    const ok = await vscode.window.showWarningMessage(
      tr('Откатить {0}:{1} на {2}?', config.host, config.path, target ? tr('копию последней выкладки') : tr('последнюю сохранённую копию')),
      { modal: true, detail: tr('Файлы из копии вернутся на место, потом выполнится перезапуск и проверка. Новые файлы, которых не было в копии, останутся на сервере.') },
      tr('Откатить'),
    );
    if (ok !== tr('Откатить')) return;
  }
  dash.show();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Quorvox: откатываю…') }, () =>
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
    vscode.window.showInformationMessage(r.existing ? tr('.env.example уже содержит все переменные из кода.') : tr('В серверном коде не нашёл переменных окружения.'));
    return;
  }
  const file = join(dir, '.env.example');
  writeFileSync(file, r.text, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage(tr('{0} .env.example: {1} переменных (только имена, без значений).', r.existing ? tr('Дописал в') : tr('Создал'), r.added.length));
  runChecks();
}

function startAll() {
  if (!requireTrust(tr('запускать сервисы'))) return;
  if (!stack || stack.runners.length === 0) {
    vscode.window.showInformationMessage(
      tr('В этой папке нет проекта для запуска. Подойдёт: package.json со скриптом dev или start, index.html (запущу как сайт) или quorvox.json. Для не-веб-папки это нормально.'),
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
      return requireTrust(tr('запускать сервис')) ? r?.start() : undefined;
    case 'stop':
      return void (await r?.stop());
    case 'restart':
      return requireTrust(tr('перезапускать сервис')) ? void (await r?.restart()) : undefined;
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
    out.appendLine(tr('[quorvox] вид «Проверки» не зарегистрирован: перезагрузи окно (Developer: Reload Window)'));
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

  applyLanguage(false);
  const imp = registerImport(ctx, { root, log: (l) => out.appendLine(l), rescan: rebuild });
  ctx.subscriptions.push(
    ...imp.disposables,
    vscode.workspace.onDidGrantWorkspaceTrust(() => refresh()),
    vscode.commands.registerCommand('quorvox.language', pickLanguage),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('quorvox.language')) applyLanguage(true);
    }),
    out,
    bar,
    { dispose: () => dash.dispose() },
    vscode.window.createTreeView('quorvox.services', { treeDataProvider: tree }),
    { dispose: () => checksView_?.dispose() },
    { dispose: () => mapPanel.dispose() },
    { dispose: () => clearTimeout(checkTimer) },
    ...registerMove(ctx, {
      root,
      checkCount: () => {
        runChecks();
        return issueCount();
      },
      log: (l) => out.appendLine(l),
    }),
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
    vscode.commands.registerCommand('quorvox.service.start', async (a?: { name?: string }) => (requireTrust(tr('запускать сервис')) ? (await pickRunner(a))?.start() : undefined)),
    vscode.commands.registerCommand('quorvox.service.stop', async (a?: { name?: string }) => void (await (await pickRunner(a))?.stop())),
    vscode.commands.registerCommand('quorvox.service.restart', async (a?: { name?: string }) => void (requireTrust(tr('перезапускать сервис')) ? await (await pickRunner(a))?.restart() : undefined)),
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
  imp.resume();
}

export async function deactivate() {
  await stack?.stopAll();
}
