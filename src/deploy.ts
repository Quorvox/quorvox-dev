import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { tr, N } from './i18n.ts';

// Выкладка проекта на свой сервер (VPS) по ssh.
// Правила: только вход по ключу (пароли не спрашиваем), .env / базы / ключи не уходят никогда,
// перед заливкой на сервере сохраняется копия текущего кода, ничего на сервере не удаляется.

export interface DeployConfig {
  host: string;
  user: string;
  path: string; // папка проекта на сервере, абсолютный путь
  port?: number; // порт ssh
  exclude?: string[]; // что ещё не отправлять: «uploads», «*.bak», «docs/private»
  install?: string; // команда на сервере после заливки, например «npm ci --omit=dev»
  restart?: string; // например «pm2 restart quorchess» или «sudo systemctl restart quorchess»
  check?: string; // проверка, что всё поднялось, например «curl -fsS -o /dev/null http://127.0.0.1:3410/»
  backupDir?: string; // куда класть копии кода на сервере (по умолчанию рядом с проектом)
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseDeployConfig(raw: unknown): { config: DeployConfig | null; problems: string[] } {
  const d = (raw as { deploy?: Record<string, unknown> } | null)?.deploy;
  if (!d || typeof d !== 'object') return { config: null, problems: [] };
  const problems: string[] = [];
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string).trim() : '');

  const host = str('host');
  const user = str('user');
  const path = str('path');
  // имена начинаются с буквы/цифры: иначе строка вроде «-oProxyCommand=…» превратилась бы в опцию ssh
  if (!host) problems.push(tr('не указан host (адрес сервера)'));
  else if (!SAFE_NAME.test(host)) problems.push(tr('host выглядит странно: ожидаю адрес или имя сервера без пробелов и спецсимволов'));
  if (!user) problems.push(tr('не указан user (имя пользователя на сервере)'));
  else if (!SAFE_NAME.test(user)) problems.push(tr('user выглядит странно: ожидаю обычное имя пользователя'));
  if (!path) problems.push(tr('не указан path (папка проекта на сервере)'));
  else if (!path.startsWith('/') || path === '/' || path.includes('\0') || /(^|\/)\.\.(\/|$)/.test(path)) {
    problems.push(tr('path должен быть абсолютным путём к папке проекта, например /opt/quorchess (не «/» и без «..»)'));
  }
  let port: number | undefined;
  if (d.port !== undefined) {
    port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(tr('port ssh должен быть числом от 1 до 65535'));
  }
  const exclude = Array.isArray(d.exclude) ? d.exclude.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;
  if (problems.length) return { config: null, problems };
  const cfg: DeployConfig = { host, user, path: path.replace(/\/+$/, '') };
  if (port) cfg.port = port;
  if (exclude?.length) cfg.exclude = exclude;
  for (const k of ['install', 'restart', 'check', 'backupDir'] as const) if (str(k)) cfg[k] = str(k);
  return { config: cfg, problems: [] };
}

export function readDeployConfig(root: string): { config: DeployConfig | null; problems: string[] } {
  try {
    return parseDeployConfig(JSON.parse(readFileSync(join(root, 'quorvox.json'), 'utf8')));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { config: null, problems: [] }
      : { config: null, problems: [tr('quorvox.json не читается: ') + (e as Error).message] };
  }
}

// ---------- что отправлять ----------

const SKIP_DIRS = new Set(['node_modules', 'data', 'logs', 'log', 'tmp', 'temp', 'uploads', 'coverage']);
const SKIP_FILE_RE: [RegExp, string][] = [
  [/\.(db|sqlite3?|sqlite)(-wal|-shm|-journal)?$/i, N('базы данных')],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, N('ключи и сертификаты')],
  [/^(id_rsa|id_ed25519|id_ecdsa)/, N('ключи и сертификаты')],
  [/\.(log|vsix)$/i, N('логи и пакеты')],
  [/^(Thumbs\.db)$/, N('мусор ОС')],
];
const ENV_OK = new Set(['.env.example', '.env.sample']);

export interface Plan {
  files: string[]; // пути относительно корня, через /
  bytes: number;
  skipped: { what: string; why: string }[];
  warnings: string[];
  tooBig?: string;
}

const MAX_FILES = 20000;
const MAX_BYTES = 300 * 1024 * 1024;

function globToRe(g: string): RegExp {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

export function planFiles(root: string, cfg: Pick<DeployConfig, 'exclude'> = {}): Plan {
  const files: string[] = [];
  let bytes = 0;
  const skipped = new Map<string, string>();
  const warnings: string[] = [];
  const user = (cfg.exclude ?? []).map((p) => p.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, ''));
  const userHit = (rel: string, name: string) =>
    user.some((p) => (p.includes('*') || p.includes('?') ? globToRe(p).test(name) : rel === p || rel.startsWith(p + '/') || name === p));

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (e.isSymbolicLink()) {
        skipped.set(rel, tr('ссылка (не следую)'));
        continue;
      }
      if (userHit(rel, e.name)) {
        skipped.set(rel, tr('исключено в quorvox.json'));
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) skipped.set(rel + '/', e.name === 'node_modules' ? tr('зависимости (на сервере ставятся командой install)') : e.name === 'data' ? tr('данные и базы сервера') : tr('данные и временные файлы'));
        else if (e.name.startsWith('.')) skipped.set(rel + '/', tr('скрытая папка'));
        else stack.push(abs);
        continue;
      }
      if (e.name === 'quorvox.json') {
        skipped.set(rel, tr('настройки расширения (серверу не нужны)'));
        continue;
      }
      if (e.name.startsWith('.env') && !ENV_OK.has(e.name)) {
        skipped.set(rel, tr('секреты (.env никогда не отправляется)'));
        continue;
      }
      if (e.name.startsWith('.') && !ENV_OK.has(e.name)) {
        skipped.set(rel, tr('скрытый файл'));
        continue;
      }
      const bad = SKIP_FILE_RE.find(([re]) => re.test(e.name));
      if (bad) {
        skipped.set(rel, tr(bad[1]));
        continue;
      }
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      files.push(rel);
      bytes += size;
      if (files.length > MAX_FILES) return { files: [], bytes, skipped: [], warnings, tooBig: tr('больше {0} файлов', MAX_FILES) };
      if (bytes > MAX_BYTES) return { files: [], bytes, skipped: [], warnings, tooBig: tr('больше {0} МБ', MAX_BYTES / 1024 / 1024) };
    }
  }
  files.sort();
  if (files.some((f) => /[^\x00-\x7f]/.test(f))) {
    warnings.push(tr('Есть файлы с не-латинскими именами: на Windows архиватор может их исказить. Лучше переименовать.'));
  }
  return {
    files,
    bytes,
    skipped: [...skipped].map(([what, why]) => ({ what, why })).sort((a, b) => a.what.localeCompare(b.what)),
    warnings,
  };
}

// очевидные секреты в файлах, которые собираемся отправить
const SECRET_RE: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, N('приватный ключ')],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, N('токен Telegram-бота')],
  [/\bghp_[A-Za-z0-9]{36}\b/, N('токен GitHub')],
  [/\bAKIA[0-9A-Z]{16}\b/, N('ключ AWS')],
  [/\bsk-[A-Za-z0-9]{32,}\b/, N('API-ключ')],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, N('токен Slack')],
];

export function findSecrets(root: string, files: string[]): { file: string; kind: string }[] {
  const out: { file: string; kind: string }[] = [];
  for (const f of files) {
    if (!/\.(js|mjs|cjs|ts|json|html?|txt|md|ya?ml|toml|ini|cfg|conf|sh|py|env\.example|sample)$/i.test(f)) continue;
    let text: string;
    try {
      const abs = join(root, f);
      if (statSync(abs).size > 300_000) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const [re, kind] of SECRET_RE) {
      if (re.test(text)) {
        out.push({ file: f, kind: tr(kind) });
        break;
      }
    }
    if (out.length >= 10) break;
  }
  return out;
}

// ---------- запуск команд ----------

export interface RunOpts {
  cwd?: string;
  input?: string;
  onLine?: (line: string) => void;
}
export type Run = (cmd: string, args: string[], opts?: RunOpts) => Promise<{ code: number; out: string }>;

export const realRun: Run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let out = '';
    let buf = '';
    const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill(), 10 * 60 * 1000);
    const feed = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      out += s;
      buf += s;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) opts.onLine?.(l);
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: out + String(e.message) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (buf) opts.onLine?.(buf);
      resolve({ code: code ?? 1, out });
    });
    if (opts.input !== undefined) p.stdin.end(opts.input);
    else p.stdin.end();
  });

// ---------- команды для сервера ----------

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // безопасная строка для sh

const sshBase = (cfg: DeployConfig) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(cfg.port ? ['-p', String(cfg.port)] : [])];
const scpBase = (cfg: DeployConfig) => ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(cfg.port ? ['-P', String(cfg.port)] : [])];
const target = (cfg: DeployConfig) => `${cfg.user}@${cfg.host}`;
export const backupDirOf = (cfg: DeployConfig) => cfg.backupDir ?? `${cfg.path.replace(/\/[^/]*$/, '') || ''}/.quorvox-backups/${basename(cfg.path)}`;

// create: первая выкладка в папку, которой ещё нет (создаём её, копию старого кода делать не из чего)
export function buildDeployScript(cfg: DeployConfig, remoteArchive: string, ts: string, create = false): string {
  const lines = [
    'set -e',
    `P=${q(cfg.path)}`,
    `B=${q(backupDirOf(cfg))}`,
    `A=${q(remoteArchive)}`,
    ...(create ? ['mkdir -p "$P"'] : []),
    '[ -d "$P" ] || { echo "QV_FAIL no-dir"; exit 3; }',
    'echo "QV_STEP backup"',
    'mkdir -p "$B"',
    // копия текущего кода: без зависимостей, данных, секретов и баз. В пустой папке копировать нечего
    `if [ -n "$(ls -A "$P" 2>/dev/null)" ]; then tar -czf "$B/${ts}.tgz" -C "$P" --exclude=./node_modules --exclude=./data --exclude=./logs --exclude=./uploads --exclude='./.env*' --exclude='*.db' --exclude='*.db-*' .; else echo "первая выкладка: копировать нечего"; fi`,
    'ls -1t "$B"/*.tgz 2>/dev/null | tail -n +6 | while read f; do rm -f "$f"; done',
    'echo "QV_STEP unpack"',
    // права и владельца берём не из архива (собранного на Windows он даёт файлы с rw-rw-rw-), а по umask сервера
    'umask 022',
    'tar --no-same-owner --no-same-permissions -xzf "$A" -C "$P"',
    'rm -f "$A"',
    'cd "$P"',
  ];
  if (cfg.install) lines.push('echo "QV_STEP install"', cfg.install);
  if (cfg.restart) lines.push('echo "QV_STEP restart"', cfg.restart);
  if (cfg.check) lines.push('echo "QV_STEP check"', cfg.check);
  lines.push('echo QV_OK');
  return lines.join('\n') + '\n';
}

// имя копии — только дата-время (20261112-110810): иначе через него можно было бы подсунуть чужой путь
const STAMP_RE = /^\d{8}-\d{6}$/;
function assertStamp(ts: string): string {
  if (!STAMP_RE.test(ts)) throw new Error(tr('некорректное имя копии: ') + ts);
  return ts;
}

// backup: откатить именно на эту копию (иначе — на самую свежую)
export function buildRollbackScript(cfg: DeployConfig, backup?: string): string {
  const pick = backup !== undefined ? `LAST="$B/${assertStamp(backup)}.tgz"` : 'LAST=$(ls -1t "$B"/*.tgz 2>/dev/null | head -n 1 || true)';
  const lines = [
    'set -e',
    `P=${q(cfg.path)}`,
    `B=${q(backupDirOf(cfg))}`,
    pick,
    '[ -n "$LAST" ] && [ -f "$LAST" ] || { echo "QV_FAIL на сервере нет сохранённых копий (возможно, её уже удалили)"; exit 4; }',
    'echo "QV_STEP rollback $LAST"',
    'umask 022',
    'tar --no-same-owner --no-same-permissions -xzf "$LAST" -C "$P"',
    'cd "$P"',
  ];
  if (cfg.restart) lines.push('echo "QV_STEP restart"', cfg.restart);
  if (cfg.check) lines.push('echo "QV_STEP check"', cfg.check);
  lines.push('echo QV_OK');
  return lines.join('\n') + '\n';
}

// ---------- выкладка ----------

export interface DeployHooks {
  run: Run;
  log: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>; // для тестов: не ждать по-настоящему
}

// Сервер может оборвать подряд идущие подключения (ограничение частоты, fail2ban). Если соединение оборвалось
// ДО начала работы (код 255 и ни одного шага QV_STEP), пробуем ещё раз. Оборвалось посреди скрипта — не повторяем,
// чтобы ничего не выполнить дважды.
async function runRetry(hooks: DeployHooks, cmd: string, args: string[], opts?: RunOpts): Promise<{ code: number; out: string }> {
  const wait = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let r = await hooks.run(cmd, args, opts);
  for (let i = 1; i <= 2 && r.code === 255 && !r.out.includes('QV_STEP'); i++) {
    hooks.log(tr('Сервер оборвал соединение, пробую ещё раз ({0}/2)…', i));
    await wait(4000 * i);
    r = await hooks.run(cmd, args, opts);
  }
  return r;
}

export interface DeployResult {
  ok: boolean;
  step: string; // на каком шаге остановились: archive | upload | server | done
  failedAt?: string; // шаг на сервере: backup, unpack, install, restart, check
  backup?: string;
  noDir?: boolean; // на сервере нет папки проекта: можно предложить создать её (первая выкладка)
  hasBackup?: boolean; // у этой выкладки есть копия старой версии (можно откатить или подтвердить)
  message: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const SSH_HELP = () =>
  tr('Не получилось подключиться по ssh. Пароли расширение не спрашивает: должен работать вход по ключу. Проверь в терминале: ssh user@host (и что сервер уже есть в known_hosts).');

function remoteResult(out: string, code: number): { ok: boolean; failedAt?: string; reason?: string } {
  const steps = [...out.matchAll(/^QV_STEP (\S+)/gm)].map((m) => m[1]);
  const fail = /^QV_FAIL (.+)$/m.exec(out);
  if (code === 0 && /^QV_OK$/m.test(out)) return { ok: true };
  if (code === 255) return { ok: false, reason: SSH_HELP() };
  return { ok: false, failedAt: steps[steps.length - 1], reason: fail?.[1] };
}

export async function makeArchive(root: string, files: string[], run: Run): Promise<{ file: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'quorvox-deploy-'));
  writeFileSync(join(dir, 'files.txt'), files.join('\n') + '\n', 'utf8');
  const r = await run('tar', ['-czf', join(dir, 'release.tgz'), '-C', root, '-T', join(dir, 'files.txt')]);
  if (r.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(tr('не получилось собрать архив (tar): ') + r.out.trim().slice(-300));
  }
  return { file: join(dir, 'release.tgz'), dir };
}

export async function deployRelease(
  root: string,
  cfg: DeployConfig,
  files: string[],
  hooks: DeployHooks,
  opts: { create?: boolean } = {},
): Promise<DeployResult> {
  const ts = stamp((hooks.now ?? (() => new Date()))());
  const remoteArchive = `/tmp/quorvox-${ts}.tgz`;
  let tmp: { file: string; dir: string } | null = null;
  try {
    hooks.log(tr('Собираю архив ({0} файлов)…', files.length));
    try {
      tmp = await makeArchive(root, files, hooks.run);
    } catch (e) {
      return { ok: false, step: 'archive', message: (e as Error).message };
    }

    hooks.log(tr('Отправляю на {0}…', target(cfg)));
    // scp запускаем из папки архива и с коротким именем: путь вида «A:\…» scp принял бы за адрес сервера
    const up = await runRetry(hooks, 'scp', [...scpBase(cfg), 'release.tgz', `${target(cfg)}:${remoteArchive}`], { cwd: tmp.dir, onLine: hooks.log });
    if (up.code !== 0) {
      return { ok: false, step: 'upload', message: up.code === 255 ? SSH_HELP() : tr('Не получилось отправить архив: ') + up.out.trim().slice(-300) };
    }

    hooks.log(tr('Раскладываю на сервере (копия старого кода → распаковка → установка → перезапуск → проверка)…'));
    const script = buildDeployScript(cfg, remoteArchive, ts, !!opts.create);
    const r = await runRetry(hooks, 'ssh', [...sshBase(cfg), target(cfg), 'sh -s'], { input: script, onLine: hooks.log });
    const res = remoteResult(r.out, r.code);
    if (!res.ok && res.reason === 'no-dir') {
      // архив остался в /tmp на сервере: подчищаем, чтобы не копился
      await hooks.run('ssh', [...sshBase(cfg), target(cfg), `rm -f ${q(remoteArchive)}`]);
      return { ok: false, step: 'server', noDir: true, message: tr('На сервере нет папки {0}. Если это первая выкладка, её можно создать.', cfg.path) };
    }
    if (!res.ok) {
      const where = res.failedAt ? tr(' на шаге «{0}»', tr(STEP_NAMES[res.failedAt] ?? res.failedAt)) : '';
      // старый код уже сохранён, если дошли хотя бы до распаковки
      const backedUp = res.failedAt && res.failedAt !== 'backup';
      return {
        ok: false,
        step: 'server',
        failedAt: res.failedAt,
        backup: backedUp ? ts : undefined,
        message: tr('Не получилось{0}. {1}', where, res.reason ?? '').trim(),
      };
    }
    // в пустую папку (первая выкладка) копировать было нечего: откатываться некуда
    const hasBackup = !r.out.includes('первая выкладка: копировать нечего');
    return { ok: true, step: 'done', backup: hasBackup ? ts : undefined, hasBackup, message: tr('Выложено и проверено.') };
  } finally {
    if (tmp) rmSync(tmp.dir, { recursive: true, force: true });
  }
}

// Выкладка подтверждена («работает»): удаляем копию старой версии именно этой выкладки, больше ничего
export function buildConfirmScript(cfg: DeployConfig, backup: string): string {
  assertStamp(backup);
  return [
    'set -e',
    `B=${q(backupDirOf(cfg))}`,
    `F="$B/${backup}.tgz"`,
    'if [ -f "$F" ]; then rm -f -- "$F"; echo "QV_STEP removed"; else echo "копии уже нет"; fi',
    'echo QV_OK',
  ].join('\n') + '\n';
}

export async function confirmRelease(cfg: DeployConfig, backup: string, hooks: DeployHooks): Promise<DeployResult> {
  hooks.log(tr('Подтверждено: удаляю копию старой версии с сервера…'));
  const r = await runRetry(hooks, 'ssh', [...sshBase(cfg), target(cfg), 'sh -s'], { input: buildConfirmScript(cfg, backup), onLine: hooks.log });
  const res = remoteResult(r.out, r.code);
  if (!res.ok) return { ok: false, step: 'server', message: tr('Не получилось удалить копию. {0}', res.reason ?? '').trim() };
  return { ok: true, step: 'done', message: tr('Копия старой версии удалена. Выкладка закреплена.') };
}

export async function rollbackRelease(cfg: DeployConfig, hooks: DeployHooks, backup?: string): Promise<DeployResult> {
  hooks.log(backup ? tr('Откатываю на копию {0}…', backup) : tr('Откатываю на последнюю сохранённую копию…'));
  const r = await runRetry(hooks, 'ssh', [...sshBase(cfg), target(cfg), 'sh -s'], { input: buildRollbackScript(cfg, backup), onLine: hooks.log });
  const res = remoteResult(r.out, r.code);
  if (!res.ok) {
    const where = res.failedAt ? tr(' на шаге «{0}»', tr(STEP_NAMES[res.failedAt] ?? res.failedAt)) : '';
    return { ok: false, step: 'server', failedAt: res.failedAt, message: tr('Откат не удался{0}. {1}', where, res.reason ?? '').trim() };
  }
  return { ok: true, step: 'done', message: tr('Откатил на прошлую версию и проверил.') };
}

const STEP_NAMES: Record<string, string> = {
  backup: N('копия старого кода'),
  unpack: N('распаковка'),
  install: N('установка зависимостей'),
  restart: N('перезапуск'),
  check: N('проверка'),
};

// что будет сделано — для окна подтверждения и «сухого прогона»
export function describePlan(cfg: DeployConfig, plan: Plan): string[] {
  const mb = (plan.bytes / 1024 / 1024).toFixed(1);
  const lines = [tr('Куда: {0}:{1}{2}', target(cfg), cfg.path, cfg.port ? tr(' (порт ') + cfg.port + ')' : ''), tr('Что: {0} файлов, {1} МБ', plan.files.length, mb)];
  lines.push(tr('Сначала на сервере сохранится копия текущего кода в {0}', backupDirOf(cfg)));
  const after = [cfg.install && `«${cfg.install}»`, cfg.restart && `«${cfg.restart}»`, cfg.check && `«${cfg.check}»`].filter(Boolean);
  lines.push(after.length ? tr('Потом на сервере выполнится: {0}', after.join(', ')) : tr('После заливки на сервере ничего не запускается (install/restart/check не заданы)'));
  return lines;
}
