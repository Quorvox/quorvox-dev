import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export interface ServiceDef {
  name: string;
  cwd: string;
  command: string;
  // команда сама следит за файлами (nodemon, --watch, vite) — мы её не рестартим
  selfWatch: boolean;
  // подключать локальный прокси (живое обновление, QR для телефона, ошибки браузера)
  liveReload: boolean;
  // у сервиса своя перезагрузка страниц (Vite, Next...): прокси работает без перезагрузок, только QR и логи браузера
  ownReload?: boolean;
  // static — сайт без бэкенда: раздаём папку встроенным сервером
  kind?: 'static';
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);
const SELF_WATCH = /nodemon|--watch|\bvite\b|next dev|webpack(-dev)? serve|ts-node-dev|tsx watch|parcel|nuxt dev/;
// у этих своё обновление страницы (HMR), наш прокси не нужен
const OWN_RELOAD = /\bvite\b|next dev|webpack(-dev)? serve|parcel|nuxt dev/;

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fromPackage(dir: string, name: string): ServiceDef | null {
  const scripts = readJson(join(dir, 'package.json'))?.scripts;
  if (!scripts) return null;
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!script) return null;
  const text = String(scripts[script]);
  return {
    name,
    cwd: dir,
    command: `npm run ${script}`,
    selfWatch: SELF_WATCH.test(text),
    liveReload: true,
    ownReload: OWN_RELOAD.test(text),
  };
}

// сайт без бэкенда: ищем index.html в корне и в типичных папках, иначе любые html в корне
const STATIC_DIRS = ['', 'public', 'dist', 'docs', 'www', 'site', 'src', 'app'];

function staticSite(root: string): ServiceDef | null {
  const make = (dir: string): ServiceDef => ({ name: basename(root), cwd: dir, command: 'static', selfWatch: true, liveReload: true, kind: 'static' });
  for (const sub of STATIC_DIRS) {
    const dir = sub ? join(root, sub) : root;
    if (existsSync(join(dir, 'index.html'))) return make(dir);
  }
  try {
    if (readdirSync(root).some((f) => /\.html?$/i.test(f))) return make(root);
  } catch {
    // нечитаемая папка — сайта нет
  }
  return null;
}

// quorvox.json в корне главнее автопоиска:
// { "services": [{ "name": "api", "cwd": "server", "command": "node index.js", "restartOnSave": true }] }
function fromConfig(root: string): ServiceDef[] | null {
  const list = readJson(join(root, 'quorvox.json'))?.services;
  if (!Array.isArray(list) || !list.length) return null;
  return list
    .filter((s: any) => s && (typeof s.command === 'string' || typeof s.static === 'string'))
    .map((s: any, i: number): ServiceDef => {
      const name = String(s.name ?? (typeof s.static === 'string' ? 'site' : `service${i + 1}`));
      // { "static": "public" } — раздать папку встроенным сервером, без команды
      if (typeof s.static === 'string') {
        return { name, cwd: resolve(root, s.static), command: 'static', selfWatch: true, liveReload: s.liveReload !== false, kind: 'static' };
      }
      return {
        name,
        cwd: resolve(root, String(s.cwd ?? '.')),
        command: s.command,
        selfWatch: s.restartOnSave === false,
        liveReload: s.liveReload !== false,
        ownReload: s.ownReload === true,
      };
    });
}

export function detectServices(root: string): ServiceDef[] {
  const cfg = fromConfig(root);
  if (cfg) return cfg;

  const found: ServiceDef[] = [];
  const rootSvc = fromPackage(root, basename(root));
  if (rootSvc) found.push(rootSvc);

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const svc = fromPackage(join(root, e.name), e.name);
    if (svc) found.push(svc);
  }
  // запускать нечего, но это сайт из HTML-файлов — раздаём его сами
  if (!found.length) {
    const site = staticSite(root);
    if (site) found.push(site);
    else {
      // папка, где лежат несколько сайтов (каждый в своей подпапке с index.html): поднимаем каждый
      for (const e of entries) {
        if (found.length >= 8) break;
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const dir = join(root, e.name);
        if (existsSync(join(dir, 'index.html'))) {
          found.push({ name: e.name, cwd: dir, command: 'static', selfWatch: true, liveReload: true, kind: 'static' });
        }
      }
    }
  }
  return found;
}
