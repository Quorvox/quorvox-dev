import { EventEmitter } from 'node:events';
import { relative, resolve, sep } from 'node:path';
import { ServiceRunner } from './runner.ts';
import { StaticRunner } from './staticrunner.ts';
import { LiveProxy, probeHttp } from './live.ts';
import type { BrowserLog } from './live.ts';
import type { ServiceDef } from './detect.ts';
import { tr } from './i18n.ts';

// серверные файлы — их правка требует рестарта
const SERVER_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.env']);
// html/css — это всегда клиент: только обновляем браузер
const STATIC_EXT = new Set(['.html', '.htm', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2']);
// всё внутри этих папок — клиентская часть (в том числе .js)
const CLIENT_DIRS = new Set(['public', 'static', 'client', 'www', 'assets', 'web', 'dist', 'build']);
// папки, куда сервер сам пишет данные — рестарт от них даст бесконечный цикл
const IGNORE_DIRS = new Set(['node_modules', 'data', 'logs', 'tmp', 'uploads', 'coverage']);
const DEBOUNCE_MS = 300;
// больше стольких рестартов за окно — считаем, что цикл, и ждём тишины
const MAX_RESTARTS = 5;
const WINDOW_MS = 10000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// порты из строк вроде «listening on http://localhost:3410» или «port 3000»
function findPorts(line: string): number[] {
  const found = new Set<number>();
  for (const m of line.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/gi)) found.add(Number(m[1]));
  for (const m of line.matchAll(/\bport\D{0,3}(\d{2,5})\b/gi)) found.add(Number(m[1]));
  return [...found].filter((p) => p >= 80 && p <= 65535);
}

export class Stack extends EventEmitter {
  runners: ServiceRunner[];
  private timers = new Map<ServiceRunner, ReturnType<typeof setTimeout>>();
  private history = new Map<ServiceRunner, number[]>();
  private tried = new Map<ServiceRunner, Set<number>>();
  // сервисы, которые прямо сейчас перезапускаются (статус на миг «остановлен», но это не то же самое, что выключен)
  private busy = new Set<ServiceRunner>();

  constructor(defs: ServiceDef[]) {
    super();
    this.runners = defs.map((d) => {
      const r = d.kind === 'static' ? new StaticRunner(d) : new ServiceRunner(d);
      r.on('log', (line: string) => {
        this.emit('log', d.name, line);
        if (!r.proxy) void this.tryAttach(r, line);
      });
      r.on('status', () => this.emit('status'));
      return r;
    });
  }

  // нашли порт в логах → проверили, что там HTTP → подняли прокси с live-reload
  private async tryAttach(r: ServiceRunner, line: string) {
    if (!r.def.liveReload) return;
    const tried = this.tried.get(r) ?? new Set<number>();
    this.tried.set(r, tried);
    for (const port of findPorts(line)) {
      if (tried.has(port) || r.proxy) continue;
      tried.add(port);
      let ok = false;
      for (let i = 0; i < 4 && !ok; i++) {
        ok = await probeHttp(port);
        if (!ok) await sleep(300);
      }
      if (!ok || r.proxy) continue;
      const p = new LiveProxy(port);
      // Vite/Next: свою перезагрузку не трогаем, но QR и ошибки браузера работают; Host подменяем под localhost
      p.reloadEnabled = !r.def.ownReload;
      p.rewriteHost = !!r.def.ownReload;
      r.proxy = p;
      // ошибки из браузера (с компьютера и с телефона) идут в те же логи, что и сервер
      p.on('browserlog', (b: BrowserLog) => {
        const who = b.device === 'phone' ? tr('📱 [телефон]') : tr('🌐 [браузер]');
        this.emit('log', r.def.name, `${who} ${b.level}: ${b.text}${b.page ? ' — ' + b.page : ''}`);
      });
      try {
        const lp = await p.listen();
        const url = `http://localhost:${lp}`;
        this.emit('log', r.def.name, tr('live-reload: открывай {0} — страница будет обновляться сама', url));
        this.emit('proxy', r.def.name, url);
      } catch {
        p.close();
        r.proxy = null;
      }
    }
  }

  startAll() {
    for (const r of this.runners) r.start();
  }

  // доступ с телефона: открыть адрес в локальной сети для сервиса (или null, если сети нет / прокси ещё не поднят)
  async phoneOn(name: string): Promise<string | null> {
    const r = this.runners.find((x) => x.def.name === name);
    const url = r?.proxy ? await r.proxy.exposeLan() : null;
    this.emit('status');
    return url;
  }

  phoneOff(name: string) {
    this.runners.find((x) => x.def.name === name)?.proxy?.hideLan();
    this.emit('status');
  }

  async stopAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.busy.clear();
    for (const r of this.runners) {
      r.proxy?.close();
      r.proxy = null;
    }
    this.tried.clear();
    await Promise.all(this.runners.map((r) => r.stop()));
  }

  anyRunning() {
    return this.runners.some((r) => r.status === 'running');
  }

  anyCrashed() {
    return this.runners.some((r) => r.status === 'crashed');
  }

  // адреса с live-reload (для кнопки «Открыть в браузере»)
  urls(): { name: string; url: string }[] {
    return this.runners
      .filter((r) => r.proxy && r.proxy.port)
      .map((r) => ({ name: r.def.name, url: `http://localhost:${r.proxy!.port}` }));
  }

  // какие сервисы затронуты изменённым файлом (берём самую глубокую папку)
  private owners(file: string): ServiceRunner[] {
    const abs = resolve(file);
    const hits = this.runners.filter((r) => {
      const rel = relative(r.def.cwd, abs);
      if (rel === '' || rel.startsWith('..') || resolve(rel) === rel) return false;
      // последний сегмент — сам файл (.env не должен считаться скрытой папкой)
      const dirs = rel.split(sep).slice(0, -1);
      return !dirs.some((p) => IGNORE_DIRS.has(p) || p.startsWith('.'));
    });
    const deepest = Math.max(0, ...hits.map((r) => r.def.cwd.length));
    return hits.filter((r) => r.def.cwd.length === deepest);
  }

  // вызывается при изменении файла; возвращает сервисы, которые что-то сделают
  // (рестарт или обновление браузера)
  fileSaved(file: string): ServiceRunner[] {
    const dot = file.lastIndexOf('.');
    const ext = dot >= 0 ? file.slice(dot).toLowerCase() : '';
    const base = file.split(/[\\/]/).pop() ?? '';
    const isEnv = base.startsWith('.env');
    const touched: ServiceRunner[] = [];

    for (const r of this.owners(file)) {
      if (r.status === 'stopped' && !this.busy.has(r)) continue;
      const dirs = relative(r.def.cwd, resolve(file)).split(sep).slice(0, -1);
      // в сайте без бэкенда любой файл — клиентский: перезапускать нечего, только обновить вкладку
      const isClient = r.def.kind === 'static' || STATIC_EXT.has(ext) || dirs.some((p) => CLIENT_DIRS.has(p));

      if (isClient) {
        if (r.proxy) {
          r.proxy.reload();
          touched.push(r);
        }
        continue;
      }
      if (!SERVER_EXT.has(ext) && !isEnv) continue;

      if (r.def.selfWatch) {
        // сервис рестартится сам (node --watch и т.п.), мы только обновим вкладку, когда поднимется
        if (r.proxy) {
          void r.proxy.reloadWhenUp(700);
          touched.push(r);
        }
        continue;
      }
      this.scheduleRestart(r, base);
      touched.push(r);
    }
    return touched;
  }

  private scheduleRestart(r: ServiceRunner, base: string) {
    clearTimeout(this.timers.get(r));
    this.timers.set(
      r,
      setTimeout(() => {
        this.timers.delete(r);
        // идёт предыдущий рестарт — не теряем правку, а ждём и перезапускаем после него
        if (this.busy.has(r)) {
          this.scheduleRestart(r, base);
          return;
        }
        const now = Date.now();
        const recent = (this.history.get(r) ?? []).filter((t) => now - t < WINDOW_MS);
        if (recent.length >= MAX_RESTARTS) {
          this.history.set(r, recent);
          this.emit('log', r.def.name, tr('слишком частые перезапуски ({0}), пропускаю — похоже на цикл', base));
          return;
        }
        recent.push(now);
        this.history.set(r, recent);
        this.emit('log', r.def.name, tr('перезапуск: изменён {0}', base));
        this.busy.add(r);
        void r
          .restart()
          .then(() => r.proxy?.reloadWhenUp(300))
          .finally(() => this.busy.delete(r));
      }, DEBOUNCE_MS),
    );
  }
}
