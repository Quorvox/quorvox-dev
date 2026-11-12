import { join, relative, dirname, resolve, basename } from 'node:path';
import { scanProject, matches, resolveModule } from './checks.ts';
import { collectWeb } from './webfiles.ts';
import { analyzeCss } from './cssmap.ts';
import type { WebFile } from './webfiles.ts';
import type { Src, Route, Call } from './checks.ts';

// Карта проекта «для новичка»: кто кого подключает и вызывает.
// страницы → стили и скрипты → серверные файлы → таблицы БД и внешние сервисы.

export type NodeKind = 'page' | 'style' | 'script' | 'server' | 'table' | 'external';

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  file?: string;
  line?: number;
  text: string[]; // объяснение простыми словами
  meta?: string; // короткий счётчик на карточке: «16 адр.», «3 запр.»
  relatedTitle?: string;
  related?: { id: string; note: string }[]; // связь не по линиям, а по оформлению: клик перелетает к блоку
  lists?: { title: string; items: { label: string; note?: string; file?: string; line?: number }[] }[];
}

export interface MapEdge {
  from: string;
  to: string;
  kind: 'includes' | 'calls' | 'stores' | 'talks';
  count: number;
  indirect?: boolean; // страница подключает скрипт не напрямую, а через import
}

export interface ProjectMap {
  nodes: MapNode[];
  edges: MapEdge[];
  stats: { pages: number; styles: number; scripts: number; servers: number; routes: number; tables: number; externals: number };
  notes: string[];
}

const MAX_SCRIPTS = 40;
const MAX_SERVERS = 40;
const MAX_TABLES = 40;
const MAX_EXTERNALS = 15;

function tagAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

// что подключает страница: стили и скрипты
function pageIncludes(html: string): { styles: string[]; scripts: string[] } {
  const styles: string[] = [];
  const scripts: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = tagAttr(m[0], 'rel');
    const href = tagAttr(m[0], 'href');
    if (rel && /stylesheet/i.test(rel) && href) styles.push(href);
  }
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = tagAttr(m[0], 'src');
    if (src) scripts.push(src);
  }
  return { styles, scripts };
}

// адрес из страницы → файл на диске (учитываем, что «/css/x.css» отдаётся из public)
function resolveRef(pageAbs: string, ref: string, root: string, known: Set<string>): string | null {
  const clean = ref.split(/[?#]/)[0];
  if (!clean || /^(https?:)?\/\//i.test(clean) || clean.startsWith('data:')) return null;
  const bases = clean.startsWith('/')
    ? [dirname(pageAbs), root, join(root, 'public'), join(root, 'static'), join(root, 'www'), join(root, 'src')]
    : [dirname(pageAbs)];
  for (const b of bases) {
    const cand = resolve(b, clean.replace(/^\/+/, ''));
    if (known.has(cand.toLowerCase())) return cand;
  }
  return null;
}

// файлы, которые этот файл подключает через import / require
function localImports(f: Src, byAbs: Map<string, Src>): Src[] {
  const out = new Set<Src>();
  const re = /\bimport\s+(?:[^'"()]*?\s+from\s+)?(['"])(\.[^'"]+)\1|\bimport\(\s*(['"])(\.[^'"]+)\3\s*\)|\brequire\(\s*(['"])(\.[^'"]+)\5\s*\)/g;
  for (const m of f.src.matchAll(re)) {
    const spec = m[2] ?? m[4] ?? m[6];
    const hit = spec && resolveModule(f, spec, byAbs);
    if (hit && hit !== f) out.add(hit);
  }
  return [...out];
}

// ---------- данные и внешние сервисы ----------

const NOISE_HOSTS = /(^|\.)(localhost|w3\.org|schema\.org|sitemaps\.org|example\.(com|org|net)|mozilla\.org|npmjs\.(com|org)|xmlns)$/i;
const FRIENDLY_HOSTS: [RegExp, string][] = [
  [/telegram|^t\.me$/i, 'Telegram'],
  [/openstreetmap/i, 'OpenStreetMap'],
  [/^id\.quorvox\.ru$/i, 'Quorvox ID (вход)'],
  [/discord/i, 'Discord'],
  [/google|gstatic/i, 'Google'],
  [/yandex/i, 'Яндекс'],
  [/github/i, 'GitHub'],
  [/mapillary/i, 'Mapillary'],
  [/stripe/i, 'Stripe'],
  [/openai|anthropic/i, 'ИИ-сервис'],
];
const ENV_SERVICES: [RegExp, string][] = [
  [/process\.env\.TELEGRAM/, 'Telegram'],
  [/process\.env\.DISCORD/, 'Discord'],
  [/process\.env\.(SMTP|MAIL)/, 'Почта (SMTP)'],
  [/process\.env\.VAPID/, 'Push-уведомления'],
  [/process\.env\.STRIPE/, 'Stripe'],
  [/process\.env\.MAPILLARY/, 'Mapillary'],
  [/process\.env\.QUORVOX/, 'Quorvox ID (вход)'],
];
const PACKAGE_SERVICES: [RegExp, string][] = [
  [/require\(\s*['"]nodemailer['"]|from\s+['"]nodemailer['"]/, 'Почта (SMTP)'],
  [/require\(\s*['"]web-push['"]|from\s+['"]web-push['"]/, 'Push-уведомления'],
  [/require\(\s*['"](node-telegram-bot-api|telegraf)['"]|from\s+['"](grammy|telegraf)['"]/, 'Telegram'],
  [/require\(\s*['"]stripe['"]|from\s+['"]stripe['"]/, 'Stripe'],
  [/require\(\s*['"]discord\.js['"]|from\s+['"]discord\.js['"]/, 'Discord'],
];

function externalsOf(f: Src): Set<string> {
  const out = new Set<string>();
  for (const [re, name] of [...ENV_SERVICES, ...PACKAGE_SERVICES]) if (re.test(f.src)) out.add(name);
  for (const m of f.src.matchAll(/['"`]https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)) {
    const host = m[1].toLowerCase();
    if (NOISE_HOSTS.test(host)) continue;
    out.add(FRIENDLY_HOSTS.find(([re]) => re.test(host))?.[1] ?? host);
  }
  return out;
}

function declaredTables(servers: Src[]): Set<string> {
  const out = new Set<string>();
  for (const f of servers) {
    for (const m of f.src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_]\w*)/gi)) out.add(m[1]);
    for (const m of f.src.matchAll(/\.collection\(\s*['"](\w+)['"]\s*\)/g)) out.add(m[1]);
  }
  return out;
}

function tablesOf(f: Src, names: Set<string>): Set<string> {
  const out = new Set<string>();
  if (!names.size) return out;
  const alt = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const sql = new RegExp(`(?:\\bFROM|\\bJOIN|\\bINTO|\\bUPDATE)\\s+[\`"\\[]?(${alt})\\b`, 'gi');
  for (const m of f.src.matchAll(sql)) {
    const real = [...names].find((n) => n.toLowerCase() === m[1].toLowerCase());
    if (real) out.add(real);
  }
  for (const m of f.src.matchAll(/\.collection\(\s*['"](\w+)['"]\s*\)/g)) if (names.has(m[1])) out.add(m[1]);
  return out;
}

// ---------- сборка карты ----------

function commonPrefix(routes: Route[]): string {
  if (!routes.length) return '';
  let segs = routes[0].segs.slice();
  for (const r of routes) {
    let i = 0;
    while (i < segs.length && i < r.segs.length && segs[i] === r.segs[i]) i++;
    segs = segs.slice(0, i);
  }
  return '/' + segs.filter((s) => !s.startsWith(':')).join('/');
}

function callLabel(c: Call): string {
  return `${c.method ?? '?'} /${c.segs.join('/')}${c.tail ? '/…' : ''}`.replace(/\u0001/g, ':x');
}

function listShort(items: string[], max = 5): string {
  const uniq = [...new Set(items)];
  return uniq.slice(0, max).join(', ') + (uniq.length > max ? ` и ещё ${uniq.length - max}` : '');
}

export function buildMap(root: string): ProjectMap {
  const scan = scanProject(root);
  const { byAbs, servers, client, routes, calls } = scan;
  const web = collectWeb(root);
  const notes: string[] = [];

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgeKey = new Map<string, MapEdge>();
  const addEdge = (from: string, to: string, kind: MapEdge['kind'], count = 1, indirect = false) => {
    const key = `${from}|${to}|${kind}|${indirect}`;
    const hit = edgeKey.get(key);
    if (hit) hit.count += count;
    else {
      const e = { from, to, kind, count, indirect };
      edgeKey.set(key, e);
      edges.push(e);
    }
  };

  // --- что подключает страница ---
  const known = new Set<string>([...web.css.map((c) => c.abs.toLowerCase()), ...client.map((c) => c.abs.toLowerCase())]);
  const pageInfo: { page: WebFile; styles: string[]; scripts: string[] }[] = [];
  for (const p of web.html) {
    const inc = pageIncludes(p.src);
    const styles = inc.styles.map((s) => resolveRef(p.abs, s, root, known)).filter((x): x is string => !!x);
    const scripts = inc.scripts.map((s) => resolveRef(p.abs, s, root, known)).filter((x): x is string => !!x);
    if (styles.length || scripts.length) pageInfo.push({ page: p, styles, scripts });
  }

  // --- запросы скриптов к серверу ---
  const callsByFile = new Map<string, Call[]>();
  for (const c of calls) callsByFile.set(c.file, [...(callsByFile.get(c.file) ?? []), c]);
  const routeOf = new Map<Call, Route>();
  for (const c of calls) {
    const hits = routes.filter((r) => matches(c, r));
    const best = hits.find((r) => r.method === c.method || r.method === 'ALL') ?? hits[0];
    if (best) routeOf.set(c, best);
  }

  // --- серверные файлы с маршрутами ---
  const routesByFile = new Map<string, Route[]>();
  for (const r of routes) routesByFile.set(r.file, [...(routesByFile.get(r.file) ?? []), r]);
  const serverSrc = new Map(servers.map((s) => [s.rel, s]));

  // хаб — файл, который подключают почти все (db.js и т.п.): через него не раскрываем связи, иначе всё свяжется со всем
  const inDegree = new Map<Src, number>();
  const requires = new Map<Src, Src[]>();
  for (const s of servers) {
    const list = localImports(s, byAbs).filter((x) => x.server);
    requires.set(s, list);
    for (const x of list) inDegree.set(x, (inDegree.get(x) ?? 0) + 1);
  }
  const hubLimit = Math.max(3, Math.ceil(servers.length * 0.4));
  const isHub = (s: Src) => (inDegree.get(s) ?? 0) >= hubLimit;

  const tableNames = declaredTables(servers);
  // раскрываем только вспомогательные модули. Другие роутеры не трогаем: их таблицы принадлежат им самим,
  // иначе главный файл сервера (который всё подключает) получил бы связь со всей базой
  const helpers = (s: Src) => (requires.get(s) ?? []).filter((d) => !isHub(d) && !routesByFile.has(d.rel));
  const tablesFor = (s: Src) => {
    const out = tablesOf(s, tableNames);
    for (const dep of helpers(s)) for (const t of tablesOf(dep, tableNames)) out.add(t);
    return out;
  };
  const externalsFor = (s: Src) => {
    const out = externalsOf(s);
    for (const dep of helpers(s)) for (const e of externalsOf(dep)) out.add(e);
    return out;
  };

  // ---------- узлы ----------
  const labelFor = (rel: string, all: string[]) => {
    const b = basename(rel);
    return all.filter((x) => basename(x) === b).length > 1 ? rel : b;
  };

  // серверы
  const serverRels = [...routesByFile.keys()].sort((a, b) => routesByFile.get(b)!.length - routesByFile.get(a)!.length);
  if (serverRels.length > MAX_SERVERS) notes.push(`Серверных файлов с маршрутами ${serverRels.length}, показаны ${MAX_SERVERS} самых больших.`);
  const shownServers = serverRels.slice(0, MAX_SERVERS);

  // скрипты: те, что шлют запросы, и те, что подключены страницами напрямую
  const directScripts = new Set(pageInfo.flatMap((p) => p.scripts.map((s) => s.toLowerCase())));
  const scriptRels = [...callsByFile.keys()].sort((a, b) => callsByFile.get(b)!.length - callsByFile.get(a)!.length);
  const shownScriptRels = new Set(scriptRels.slice(0, MAX_SCRIPTS));
  if (scriptRels.length > MAX_SCRIPTS) notes.push(`Скриптов с запросами к серверу ${scriptRels.length}, показаны ${MAX_SCRIPTS} самых активных.`);
  const entryScripts = [...directScripts].map((a) => byAbs.get(a)).filter((x): x is Src => !!x);
  for (const s of entryScripts) shownScriptRels.add(s.rel);
  const scriptList = [...shownScriptRels];

  // страницы
  const pageRels = pageInfo.map((p) => p.page.rel);
  for (const p of pageInfo) {
    const id = `page:${p.page.rel}`;
    const styleNames = p.styles.map((s) => relative(root, s).replace(/\\/g, '/'));
    const scriptNames = p.scripts.map((s) => relative(root, s).replace(/\\/g, '/'));
    const text = ['Это страница сайта: то, что браузер открывает по адресу. Она собирает всё остальное.'];
    if (styleNames.length) text.push(`Подключает оформление (CSS): ${listShort(styleNames.map((x) => basename(x)))}.`);
    if (scriptNames.length) text.push(`Подключает скрипты: ${listShort(scriptNames.map((x) => basename(x)))} (а через их import подтягиваются и другие файлы).`);
    nodes.push({ id, kind: 'page', label: labelFor(p.page.rel, pageRels), file: p.page.rel, line: 1, text });
  }

  // стили
  const styleAbs = new Map<string, WebFile>();
  for (const p of pageInfo) for (const s of p.styles) {
    const f = web.css.find((c) => c.abs.toLowerCase() === s.toLowerCase());
    if (f) styleAbs.set(f.abs.toLowerCase(), f);
  }
  const styleRels = [...styleAbs.values()].map((s) => s.rel);
  for (const s of styleAbs.values()) {
    const users = pageInfo.filter((p) => p.styles.some((x) => x.toLowerCase() === s.abs.toLowerCase())).map((p) => basename(p.page.rel));
    const rules = (s.src.match(/\{/g) ?? []).length;
    nodes.push({
      id: `style:${s.rel}`,
      kind: 'style',
      label: labelFor(s.rel, styleRels),
      file: s.rel,
      line: 1,
      text: [
        'Файл оформления (CSS): отвечает за то, как выглядит сайт: цвета, шрифты, отступы, расположение блоков. Логики и данных тут нет.',
        `Примерно ${rules} правил оформления. Подключён на страницах: ${listShort(users)}.`,
      ],
    });
  }

  // скрипты
  for (const rel of scriptList) {
    const f = client.find((c) => c.rel === rel);
    if (!f) continue;
    const my = callsByFile.get(rel) ?? [];
    const text = ['Скрипт, который работает в браузере пользователя: реагирует на клики и рисует страницу.'];
    if (my.length) text.push(`Отправляет запросы на сервер (${my.length}): ${listShort(my.map(callLabel), 6)}.`);
    else text.push('Сам к серверу не обращается: подключён страницей и/или другими скриптами.');
    const users = pageInfo.filter((p) => p.scripts.some((s) => s.toLowerCase() === f.abs.toLowerCase())).map((p) => basename(p.page.rel));
    if (users.length) text.push(`Страница подключает его напрямую: ${listShort(users)}.`);
    nodes.push({
      id: `script:${rel}`,
      kind: 'script',
      label: labelFor(rel, scriptList),
      file: rel,
      line: my[0]?.line ?? 1,
      text,
      meta: my.length ? `${my.length} запр.` : undefined,
    });
  }

  // серверные файлы
  const tablesByServer = new Map<string, Set<string>>();
  const extByServer = new Map<string, Set<string>>();
  for (const rel of shownServers) {
    const s = serverSrc.get(rel)!;
    const rs = routesByFile.get(rel)!;
    const tables = tablesFor(s);
    const exts = externalsFor(s);
    tablesByServer.set(rel, tables);
    extByServer.set(rel, exts);
    const callers = new Set<string>();
    for (const [c, r] of routeOf) if (r.file === rel) callers.add(basename(c.file));
    const prefix = commonPrefix(rs);
    const text = [`Серверный файл: принимает запросы от сайта и отвечает на них. Маршрутов (адресов, которые он обслуживает): ${rs.length}.`];
    text.push(`Примеры: ${listShort(rs.map((r) => `${r.method} ${r.full}`), 4)}.`);
    if (prefix.length > 1) text.push(`Все адреса начинаются с ${prefix}.`);
    if (callers.size) text.push(`Его вызывают скрипты: ${listShort([...callers], 6)}.`);
    else text.push('Ни один скрипт сайта его пока не вызывает (или вызывает неочевидным способом).');
    if (tables.size) text.push(`Читает и пишет таблицы базы данных: ${listShort([...tables], 6)}.`);
    if (exts.size) text.push(`Обращается к внешним сервисам: ${listShort([...exts], 6)}.`);
    nodes.push({ id: `server:${rel}`, kind: 'server', label: labelFor(rel, shownServers), file: rel, line: rs[0].line, text, meta: `${rs.length} адр.` });
  }

  // таблицы и внешнее
  const tableDegree = new Map<string, number>();
  const extDegree = new Map<string, number>();
  for (const rel of shownServers) {
    for (const t of tablesByServer.get(rel)!) tableDegree.set(t, (tableDegree.get(t) ?? 0) + 1);
    for (const e of extByServer.get(rel)!) extDegree.set(e, (extDegree.get(e) ?? 0) + 1);
  }
  const shownTables = [...tableDegree.keys()].sort((a, b) => tableDegree.get(b)! - tableDegree.get(a)!).slice(0, MAX_TABLES);
  if (tableDegree.size > MAX_TABLES) notes.push(`Таблиц ${tableDegree.size}, показаны ${MAX_TABLES} самых используемых.`);
  const shownExt = [...extDegree.keys()].sort((a, b) => extDegree.get(b)! - extDegree.get(a)!).slice(0, MAX_EXTERNALS);

  for (const t of shownTables) {
    const users = shownServers.filter((r) => tablesByServer.get(r)!.has(t)).map((r) => basename(r));
    nodes.push({
      id: `table:${t}`,
      kind: 'table',
      label: t,
      text: ['Таблица в базе данных: здесь постоянно хранятся данные (то, что не должно пропасть после перезапуска).', `С ней работают файлы: ${listShort(users)}.`],
      meta: `×${users.length}`,
    });
  }
  for (const e of shownExt) {
    const users = shownServers.filter((r) => extByServer.get(r)!.has(e)).map((r) => basename(r));
    nodes.push({
      id: `ext:${e}`,
      kind: 'external',
      label: e,
      text: ['Внешний сервис: сервер обращается к нему по интернету (или через его библиотеку).', `Обращаются файлы: ${listShort(users)}.`],
      meta: `×${users.length}`,
    });
  }

  // ---------- связи ----------
  const nodeIds = new Set(nodes.map((n) => n.id));
  const scriptByAbs = new Map<string, string>();
  for (const rel of scriptList) {
    const f = client.find((c) => c.rel === rel);
    if (f) scriptByAbs.set(f.abs.toLowerCase(), `script:${rel}`);
  }

  for (const p of pageInfo) {
    const pid = `page:${p.page.rel}`;
    for (const s of p.styles) {
      const sid = styleAbs.get(s.toLowerCase());
      if (sid) addEdge(pid, `style:${sid.rel}`, 'includes');
    }
    // скрипты: напрямую и по цепочке import
    const reached = new Set<string>();
    const queue: Src[] = [];
    for (const s of p.scripts) {
      const f = byAbs.get(s.toLowerCase());
      if (f) queue.push(f);
      const id = scriptByAbs.get(s.toLowerCase());
      if (id) addEdge(pid, id, 'includes');
    }
    while (queue.length) {
      const f = queue.shift()!;
      if (reached.has(f.abs)) continue;
      reached.add(f.abs);
      for (const dep of localImports(f, byAbs)) {
        if (dep.server) continue;
        const id = scriptByAbs.get(dep.abs.toLowerCase());
        if (id && !p.scripts.some((x) => x.toLowerCase() === dep.abs.toLowerCase())) addEdge(pid, id, 'includes', 1, true);
        queue.push(dep);
      }
    }
  }
  // скрипты, которых не нашли по цепочке import (экраны часто подгружаются динамически),
  // привязываем к странице, в чьей папке они лежат
  const included = new Set(edges.filter((e) => e.kind === 'includes').map((e) => e.to));
  for (const rel of scriptList) {
    const id = `script:${rel}`;
    if (included.has(id)) continue;
    const f = client.find((c) => c.rel === rel);
    if (!f) continue;
    const owner = pageInfo
      .filter((p) => p.scripts.length && relative(dirname(p.page.abs), f.abs).split(/[\\/]/)[0] !== '..' && !relative(dirname(p.page.abs), f.abs).startsWith('..'))
      .sort((a, b) => dirname(b.page.abs).length - dirname(a.page.abs).length)[0];
    if (owner) addEdge(`page:${owner.page.rel}`, id, 'includes', 1, true);
  }

  for (const [c, r] of routeOf) {
    const from = `script:${c.file}`;
    const to = `server:${r.file}`;
    if (nodeIds.has(from) && nodeIds.has(to)) addEdge(from, to, 'calls');
  }
  for (const rel of shownServers) {
    for (const t of tablesByServer.get(rel)!) if (nodeIds.has(`table:${t}`)) addEdge(`server:${rel}`, `table:${t}`, 'stores');
    for (const e of extByServer.get(rel)!) if (nodeIds.has(`ext:${e}`)) addEdge(`server:${rel}`, `ext:${e}`, 'talks');
  }

  const byLabel = (id: string) => nodes.find((x) => x.id === id)?.label ?? id;
  // --- CSS: сколько в файле классов, какие мёртвые, кто какими пользуется ---
  const cssReport = analyzeCss(web, scan.files);
  const styleNodeByFile = new Map(nodes.filter((n) => n.kind === 'style').map((n) => [n.file!, n]));
  for (const st of cssReport.styles) {
    const n = styleNodeByFile.get(st.file);
    if (!n) continue;
    n.meta = st.dead.length ? `${st.dead.length} мёртв.` : `${st.total} кл.`;
    n.text.push(`Классов в файле: ${st.total}. ` + (st.dead.length ? `Похоже, нигде не используются: ${st.dead.length} (список ниже).` : 'Все они где-то используются.'));
    n.text.push('«Не используются» значит, что имени нет ни в HTML, ни в строках скриптов. Классы, которые ставят сторонние библиотеки, я не считаю.');
    if (st.dead.length) {
      n.lists = [{ title: 'Мёртвые классы (нажми, чтобы открыть строку)', items: st.dead.slice(0, 60).map((c) => ({ label: '.' + c.name, file: c.file, line: c.line })) }];
    }
    const rel: { id: string; note: string }[] = [];
    for (const u of st.usedBy) {
      const id = nodeIds.has(`script:${u.file}`) ? `script:${u.file}` : nodeIds.has(`page:${u.file}`) ? `page:${u.file}` : '';
      if (id) rel.push({ id, note: `${u.count} кл.` });
    }
    if (rel.length) {
      n.relatedTitle = 'Кто использует эти классы';
      n.related = rel.slice(0, 40);
    }
  }
  for (const n of nodes) {
    if (n.kind !== 'script' && n.kind !== 'page') continue;
    const rel: { id: string; note: string }[] = [];
    for (const st of cssReport.styles) {
      const u = st.usedBy.find((x) => x.file === n.file);
      const sid = `style:${st.file}`;
      if (u && nodeIds.has(sid)) rel.push({ id: sid, note: `${u.count} кл.` });
    }
    if (rel.length) {
      n.relatedTitle = 'Оформление (CSS), которое он использует';
      n.related = rel;
      n.text.push(`Использует классы из CSS: ${rel.map((r) => `${byLabel(r.id)} (${r.note})`).join(', ')}.`);
    }
  }

  if (routes.length && !edges.some((e) => e.kind === 'calls')) {
    notes.push('Связей «скрипт → сервер» не нашёл: сайт обращается к серверу способом, который я пока не распознаю (не api(\'/путь\') и не fetch(\'/api/…\')).');
  }
  if (scan.unresolved.length) notes.push(`Часть роутеров не удалось разобрать: ${scan.unresolved.join(', ')}.`);
  if (!tableNames.size && servers.length) notes.push('Таблицы базы данных не нашёл: ищу CREATE TABLE в коде сервера.');

  return {
    nodes,
    edges,
    stats: {
      pages: pageInfo.length,
      styles: styleAbs.size,
      scripts: scriptList.length,
      servers: shownServers.length,
      routes: routes.length,
      tables: shownTables.length,
      externals: shownExt.length,
    },
    notes,
  };
}
