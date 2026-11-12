import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CLIENT_URL = '/__quorvox_reload.js';
const SSE_URL = '/__quorvox_reload';
const LOG_URL = '/__quorvox_log';
const TAG = `<script src="${CLIENT_URL}"></script>`;

// Скрипт, который подмешиваем в страницы: обновляет вкладку и присылает ошибки браузера
// (в том числе с телефона) обратно в VS Code. Внутри нет обратных кавычек и ${ — это шаблонная строка.
const CLIENT_JS = `(function () {
  var LOG = '${LOG_URL}';
  function send(level, text) {
    try {
      var body = JSON.stringify({ level: level, text: String(text).slice(0, 600), page: location.pathname });
      if (navigator.sendBeacon) navigator.sendBeacon(LOG, body);
      else { var x = new XMLHttpRequest(); x.open('POST', LOG, true); x.send(body); }
    } catch (e) { /* логи не должны ломать страницу */ }
  }
  var es = new EventSource('${SSE_URL}');
  es.onmessage = function () { location.reload(); };
  window.addEventListener('error', function (e) {
    var where = e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : '';
    send('error', (e.message || 'ошибка') + where);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send('error', 'Promise: ' + (r && r.message ? r.message : r));
  });
  ['error', 'warn'].forEach(function (lvl) {
    var orig = console[lvl];
    console[lvl] = function () {
      try {
        send(lvl, Array.prototype.map.call(arguments, function (a) {
          return a && a.stack ? String(a.stack).split('\\n')[0] : (typeof a === 'object' ? JSON.stringify(a) : String(a));
        }).join(' '));
      } catch (e) { /* ничего */ }
      return orig.apply(console, arguments);
    };
  });
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var short = String(url).replace(location.origin, '');
      var mine = short.indexOf('/__quorvox') === 0;
      return origFetch.apply(this, arguments).then(function (res) {
        if (!mine && res.status >= 400 && res.status !== 401) send(res.status >= 500 ? 'error' : 'warn', method + ' ' + short + ' → ' + res.status);
        return res;
      }, function (err) {
        if (!mine) send('error', method + ' ' + short + ' → сеть недоступна' + (err && err.message ? ': ' + err.message : ''));
        throw err;
      });
    };
  }
})();`;

// адрес этого компьютера в домашней/рабочей сети (только частные диапазоны)
export function lanAddress(): string | null {
  const cand: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) cand.push(i.address);
  }
  const rank = (a: string) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  cand.sort((a, b) => rank(a) - rank(b));
  return cand.find((a) => rank(a) < 3) ?? null;
}

// пускаем только свои: локальный компьютер и частные сети
export function isPrivateAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
}

export interface BrowserLog {
  level: 'error' | 'warn';
  text: string;
  page: string;
  device: 'phone' | 'browser';
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });
}

// отвечает ли порт по HTTP — чтобы случайно не повесить прокси на порт базы из лога
export function probeHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => (req.destroy(), resolve(false)));
    req.on('error', () => resolve(false));
  });
}

// Прокси перед сервисом: на HTML-страницы подмешивает скрипт, который слушает SSE
// и перезагружает вкладку. Слушает только 127.0.0.1.
export class LiveProxy extends EventEmitter {
  port = 0;
  target: number;
  private server: http.Server;
  private lan: http.Server | null = null;
  private lanInfo: { ip: string; port: number } | null = null;
  private clients = new Set<http.ServerResponse>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private upToken = 0;
  private logTimes: number[] = [];
  private logMuted = false;
  private recentLogs = new Map<string, number>();
  // false у Vite/Next: у них своя перезагрузка страниц, мы не мешаем, но QR и логи браузера работают
  reloadEnabled = true;
  // подменять Host/Origin на localhost: dev-серверы вроде Vite не пускают запросы с адреса сети (телефон)
  rewriteHost = false;

  constructor(target: number) {
    super();
    this.target = target;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
  }

  // адрес для телефона (пока включён доступ из сети) или null
  lanUrl(): string | null {
    return this.lanInfo ? `http://${this.lanInfo.ip}:${this.lanInfo.port}` : null;
  }

  // Открыть доступ из локальной сети (для телефона). Только по явной просьбе, пускаем лишь частные адреса.
  async exposeLan(): Promise<string | null> {
    if (this.lan) return this.lanUrl();
    const ip = lanAddress();
    if (!ip) return null;
    const srv = http.createServer((req, res) => {
      if (!isPrivateAddr(req.socket.remoteAddress)) {
        res.writeHead(403).end();
        return;
      }
      this.handle(req, res);
    });
    srv.on('upgrade', (req, socket, head) => {
      if (!isPrivateAddr(req.socket.remoteAddress)) {
        socket.destroy();
        return;
      }
      this.upgrade(req, socket, head);
    });
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onErr = (e: Error) => reject(e);
        srv.once('error', onErr);
        srv.listen(port, '0.0.0.0', () => {
          srv.off('error', onErr);
          resolve((srv.address() as net.AddressInfo).port);
        });
      });
    let port: number;
    try {
      port = await listen(this.port + 1 <= 65535 ? this.port + 1 : 0);
    } catch {
      port = await listen(0);
    }
    this.lan = srv;
    this.lanInfo = { ip, port };
    return this.lanUrl();
  }

  hideLan() {
    this.lan?.close();
    this.lan?.closeAllConnections();
    this.lan = null;
    this.lanInfo = null;
  }

  // ошибка из браузера → событие, но не чаще разумного
  private acceptLog(level: string, text: string): boolean {
    const now = Date.now();
    const key = `${level}|${text}`;
    // одно и то же сообщение чаще, чем раз в 1.5 с, не повторяем (цикл с ошибкой иначе завалит логи)
    for (const [k, at] of this.recentLogs) if (now - at >= 1500) this.recentLogs.delete(k);
    if (this.recentLogs.has(key)) return false;
    this.recentLogs.set(key, now);
    this.logTimes = this.logTimes.filter((t) => now - t < 10000);
    if (this.logTimes.length >= 30) {
      if (!this.logMuted) {
        this.logMuted = true;
        this.emit('browserlog', { level: 'warn', text: 'слишком много сообщений из браузера, часть пропускаю', page: '', device: 'browser' } as BrowserLog);
      }
      return false;
    }
    if (this.logTimes.length < 10) this.logMuted = false;
    this.logTimes.push(now);
    return true;
  }

  private receiveLog(req: http.IncomingMessage, res: http.ServerResponse) {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= 8192) chunks.push(c);
    });
    req.on('end', () => {
      res.writeHead(204).end();
      if (size > 8192) return;
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const level = j.level === 'warn' ? 'warn' : 'error';
        const text = String(j.text ?? '').replace(/\s+/g, ' ').slice(0, 600);
        if (!text || !this.acceptLog(level, text)) return;
        const device = /iPhone|iPad|Android|Mobile/i.test(String(req.headers['user-agent'] ?? '')) ? 'phone' : 'browser';
        this.emit('browserlog', { level, text, page: String(j.page ?? '').slice(0, 120), device } as BrowserLog);
      } catch {
        // мусор в теле — игнорируем
      }
    });
  }

  async listen(): Promise<number> {
    // стабильный адрес: порт сервиса + 10000 (3410 → 13410); занят — любой свободный
    const wanted = this.target + 10000 <= 65000 ? this.target + 10000 : 0;
    try {
      await this.bind(wanted);
    } catch {
      await this.bind(0);
    }
    this.pingTimer = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 20000);
    this.pingTimer.unref();
    return this.port;
  }

  private bind(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.server.once('error', onErr);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onErr);
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.upToken++;
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.hideLan();
    this.server.close();
    this.server.closeAllConnections();
  }

  // сказать всем вкладкам обновиться (схлопываем частые вызовы)
  reload() {
    if (!this.reloadEnabled) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      for (const c of this.clients) c.write('data: reload\n\n');
    }, 150);
  }

  // обновить, когда сервис снова начнёт отвечать (после рестарта)
  async reloadWhenUp(delay = 300) {
    if (!this.reloadEnabled) return;
    const token = ++this.upToken;
    await sleep(delay);
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (token !== this.upToken) return;
      if (await portOpen(this.target)) {
        if (token === this.upToken) this.reload();
        return;
      }
      await sleep(200);
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === CLIENT_URL) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(CLIENT_JS);
      return;
    }
    if (req.method === 'POST' && req.url === LOG_URL) {
      this.receiveLog(req, res);
      return;
    }
    if (req.url === SSE_URL) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }

    // без сжатия, чтобы можно было вставить скрипт в HTML
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    const outsideHost = String(req.headers.host ?? '');
    if (this.rewriteHost) {
      headers.host = `localhost:${this.target}`;
      if (headers.origin) headers.origin = `http://localhost:${this.target}`;
    }
    // редиректы dev-сервера ведут на localhost:порт сервиса, а человек сидит на адресе прокси
    const fixLocation = (h: http.IncomingHttpHeaders): http.IncomingHttpHeaders => {
      const loc = h.location;
      if (!this.rewriteHost || !loc || !outsideHost) return h;
      const m = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${this.target}(?=/|$)`).exec(loc);
      return m ? { ...h, location: `http://${outsideHost}${loc.slice(m[0].length)}` } : h;
    };
    const up = http.request(
      { host: '127.0.0.1', port: this.target, method: req.method, path: req.url, headers },
      (ur) => {
        const type = String(ur.headers['content-type'] ?? '');
        const inject = req.method === 'GET' && ur.statusCode === 200 && type.includes('text/html') && !ur.headers['content-encoding'];
        if (!inject) {
          res.writeHead(ur.statusCode ?? 502, fixLocation(ur.headers));
          ur.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        ur.on('data', (c: Buffer) => chunks.push(c));
        ur.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          body = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, () => TAG + '</body>') : body + TAG;
          const h = { ...ur.headers };
          delete h['transfer-encoding'];
          h['content-length'] = String(Buffer.byteLength(body));
          res.writeHead(200, h);
          res.end(body);
        });
      },
    );
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<p style="font-family:sans-serif">Quorvox: сервис недоступен (${e.message}). Возможно, он перезапускается.</p>` +
          `${TAG}<script>setTimeout(function(){location.reload()},1500)</script>`,
      );
    });
    req.pipe(up);
  }

  // WebSocket и прочие upgrade просто пробрасываем сырым TCP
  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const up = net.connect(this.target, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        if (this.rewriteHost && /^host$/i.test(name)) value = `localhost:${this.target}`;
        else if (this.rewriteHost && /^origin$/i.test(name)) value = `http://localhost:${this.target}`;
        raw += `${name}: ${value}\r\n`;
      }
      up.write(raw + '\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    // ушёл любой из двух — рвём обе стороны сразу, иначе полуоткрытый сокет повиснет
    // (HTTP-сервер Node по умолчанию не закрывает свою половину после FIN)
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    socket.on('end', () => up.destroy());
    socket.on('close', () => up.destroy());
    up.on('end', () => socket.destroy());
    up.on('close', () => socket.destroy());
  }
}
