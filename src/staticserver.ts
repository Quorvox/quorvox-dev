import http from 'node:http';
import { createReadStream, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { tr } from './i18n.ts';

// Встроенный сервер для сайтов без бэкенда (обычные HTML/CSS/JS).
// Слушает только 127.0.0.1 (для телефона есть отдельный прокси), без кэша, скрытые файлы не отдаёт.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

// что не отдаём никогда, даже если лежит в папке сайта
const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.sqlite', '.sqlite3', '.db']);

export interface StaticServer {
  port: number;
  close(): Promise<void>;
}

function blocked(segments: string[]): boolean {
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') return true;
    if (s.startsWith('.') && s !== '.well-known') return true; // .env, .git, .htpasswd ...
    if (s.includes('\0')) return true;
  }
  const last = segments[segments.length - 1] ?? '';
  return SECRET_EXT.has(extname(last).toLowerCase());
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(status: number, title: string, body: string, res: http.ServerResponse) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;padding:24px">${body}</body>`);
}

export function createStaticHandler(root: string): http.RequestListener {
  const base = resolve(root);
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    realBase = base;
  }

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.resume(); // тело запроса не нужно, но дочитать надо: иначе соединение оборвётся
      res.writeHead(405, { allow: 'GET, HEAD', connection: 'close' }).end();
      return;
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]);
    } catch {
      page(400, tr('Некорректный адрес'), tr('<h1>400</h1><p>Некорректный адрес.</p>'), res);
      return;
    }
    const segments = urlPath.split('/');
    if (blocked(segments)) {
      page(404, tr('Не найдено'), tr('<h1>404</h1><p>Не найдено: {0}</p>', esc(urlPath)), res);
      return;
    }
    let file = join(base, ...segments.filter((s) => s !== ''));
    // ссылки-симлинки не должны выводить за пределы папки сайта
    const inside = (p: string) => {
      try {
        const real = realpathSync(p);
        return real === realBase || real.startsWith(realBase + sep);
      } catch {
        return false;
      }
    };

    let st;
    try {
      st = statSync(file);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) {
      if (!urlPath.endsWith('/')) {
        res.writeHead(301, { location: urlPath + '/' }).end();
        return;
      }
      const index = join(file, 'index.html');
      let hasIndex = false;
      try {
        hasIndex = statSync(index).isFile();
      } catch {
        hasIndex = false;
      }
      if (hasIndex) {
        file = index;
        st = statSync(index);
      } else {
        // без index.html показываем список страниц: удобно, когда сайт из нескольких файлов
        if (!inside(file)) {
          page(404, tr('Не найдено'), '<h1>404</h1>', res);
          return;
        }
        const items = readdirSync(file, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') && !['node_modules'].includes(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => `<li><a href="${encodeURI(urlPath + e.name)}${e.isDirectory() ? '/' : ''}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`)
          .join('');
        page(200, tr('Список файлов'), tr('<h1>{0}</h1><p>Здесь нет index.html, поэтому показываю файлы.</p><ul>{1}</ul>', esc(urlPath), items), res);
        return;
      }
    }
    if (!st || !st.isFile() || !inside(file)) {
      page(404, tr('Не найдено'), tr('<h1>404</h1><p>Файла нет: {0}</p>', esc(urlPath)), res);
      return;
    }
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}

// preferred, preferred+1 ... до 20 попыток, потом любой свободный
export async function startStaticServer(root: string, preferred = 5500): Promise<StaticServer> {
  const server = http.createServer(createStaticHandler(root));
  const listen = (port: number) =>
    new Promise<number>((ok, fail) => {
      const onErr = (e: Error) => fail(e);
      server.once('error', onErr);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onErr);
        ok((server.address() as AddressInfo).port);
      });
    });
  let port = 0;
  for (let i = 0; i < 20; i++) {
    try {
      port = await listen(preferred + i);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!port) port = await listen(0);
  return {
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}
