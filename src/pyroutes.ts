// Маршруты и переменные окружения в Python-серверах (Flask, FastAPI). Только чтение текста, код не запускается.

export interface PyFile {
  rel: string; // путь от корня проекта, через /
  src: string;
}

export interface PyRoute {
  method: string;
  full: string;
  segs: string[];
  file: string;
  line: number;
}

export interface PyEnv {
  name: string;
  rel: string;
  line: number;
  required: boolean;
}

const lineOf = (src: string, idx: number) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
};

// содержимое скобок от открывающей в позиции open (кавычки пропускаем)
function balanced(src: string, open: number): { text: string; end: number } | null {
  let depth = 0;
  let q = '';
  for (let i = open; i < src.length && i < open + 1500; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return { text: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

const moduleOf = (rel: string) => {
  const base = rel.split('/').pop()!.replace(/\.py$/, '');
  return base === '__init__' ? (rel.split('/').slice(-2, -1)[0] ?? base) : base;
};

const norm = (p: string) => {
  const s = ('/' + p).replace(/\/{2,}/g, '/');
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
};

// Flask: /users/<int:id>, FastAPI: /users/{id}, {path:path} → /users/:id
const toExpress = (p: string) => p.replace(/<(?:[\w.]+:)?(\w+)>/g, ':$1').replace(/\{(\w+)(?::[^}]*)?\}/g, ':$1');

const strArg = (args: string, name: string): string | undefined => new RegExp(`\\b${name}\\s*=\\s*[rbf]?(['"])([^'"]*)\\1`).exec(args)?.[2];

interface Owner {
  key: string; // модуль.переменная
  kind: 'root' | 'blueprint' | 'router';
  own: string; // собственный префикс
}

export function findPyRoutes(files: PyFile[]): PyRoute[] {
  const owners = new Map<string, Owner>();
  const edges: { parent: string; child: string; prefix: string | undefined }[] = [];
  const aliasOf = new Map<string, Map<string, string>>(); // файл → алиас → модуль.имя

  for (const f of files) {
    const mod = moduleOf(f.rel);
    const al = new Map<string, string>();
    aliasOf.set(f.rel, al);
    // from pkg.users import router as users_router, other
    for (const m of f.src.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n(]+)$/gm)) {
      const fromMod = m[1].split('.').pop()!;
      for (const part of m[2].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (name && /^\w+$/.test(name)) al.set((alias ?? name).trim(), `${fromMod}.${name}`);
      }
    }
    for (const m of f.src.matchAll(/^\s*import\s+([\w.]+)\s+as\s+(\w+)/gm)) al.set(m[2], m[1].split('.').pop()!);

    for (const m of f.src.matchAll(/^\s*(\w+)\s*(?::[^=\n]+)?=\s*(?:[\w.]+\.)?(Blueprint|APIRouter|Flask|FastAPI)\s*\(/gm)) {
      const open = m.index! + m[0].length - 1;
      const args = balanced(f.src, open)?.text ?? '';
      const kind = m[2] === 'Blueprint' ? 'blueprint' : m[2] === 'APIRouter' ? 'router' : 'root';
      const own = kind === 'blueprint' ? (strArg(args, 'url_prefix') ?? '') : kind === 'router' ? (strArg(args, 'prefix') ?? '') : '';
      owners.set(`${mod}.${m[1]}`, { key: `${mod}.${m[1]}`, kind, own });
    }
  }

  // как назвать выражение (users.router / users_router / router) ключом «модуль.переменная»
  const keyOf = (f: PyFile, expr: string): string => {
    const e = expr.trim();
    if (e.includes('.')) {
      const parts = e.split('.');
      const head = aliasOf.get(f.rel)?.get(parts[0]);
      return `${(head ?? parts[parts.length - 2]).split('.').pop()}.${parts[parts.length - 1]}`;
    }
    return aliasOf.get(f.rel)?.get(e) ?? `${moduleOf(f.rel)}.${e}`;
  };

  for (const f of files) {
    for (const m of f.src.matchAll(/(\w+)\.(register_blueprint|include_router)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const args = balanced(f.src, open)?.text ?? '';
      const first = /^\s*([\w.]+)/.exec(args)?.[1];
      if (!first) continue;
      const prefix = strArg(args, 'url_prefix') ?? strArg(args, 'prefix');
      edges.push({ parent: keyOf(f, m[1]), child: keyOf(f, first), prefix });
    }
  }

  // префиксы: от приложений вниз по регистрациям
  const prefixes = new Map<string, Set<string>>();
  for (const o of owners.values()) if (o.kind === 'root') prefixes.set(o.key, new Set(['']));
  const childPrefix = (parentP: string, child: Owner | undefined, reg: string | undefined) => {
    if (child?.kind === 'blueprint') return norm(parentP + '/' + (reg ?? child.own));
    return norm(parentP + '/' + (reg ?? '') + '/' + (child?.own ?? ''));
  };
  for (let guard = 0, changed = true; changed && guard < 10; guard++) {
    changed = false;
    for (const e of edges) {
      const pp = prefixes.get(e.parent);
      if (!pp) continue;
      for (const p of pp) {
        const np = childPrefix(p, owners.get(e.child), e.prefix);
        const set = prefixes.get(e.child) ?? new Set<string>();
        const v = np === '/' ? '' : np;
        if (!set.has(v)) {
          set.add(v);
          prefixes.set(e.child, set);
          changed = true;
        }
      }
    }
  }

  const routes: PyRoute[] = [];
  const DECOR = /^[ \t]*@(\w+)\.(route|get|post|put|patch|delete|options|head|api_route)\s*\(\s*(?:[rbf]{0,2})(['"])([^'"\n]*)\3/gm;
  for (const f of files) {
    const mod = moduleOf(f.rel);
    for (const m of f.src.matchAll(DECOR)) {
      const key = `${mod}.${m[1]}`;
      const owner = owners.get(key);
      let set = prefixes.get(key);
      // приложение/роутер не нашли среди регистраций: считаем, что он подключён со своим префиксом
      if (!set) set = new Set([owner?.kind === 'root' ? '' : norm(owner?.own ?? '') === '/' ? '' : norm(owner?.own ?? '')]);
      const open = f.src.indexOf('(', m.index!);
      const args = balanced(f.src, open)?.text ?? '';
      let methods: string[];
      if (m[2] === 'route' || m[2] === 'api_route') {
        const ml = /\bmethods\s*=\s*[\[(]([^\])]*)[\])]/.exec(args)?.[1];
        methods = ml ? [...ml.matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase()) : ['GET'];
        if (!methods.length) methods = ['GET'];
      } else methods = [m[2].toUpperCase()];
      const path = toExpress(m[4]);
      for (const p of set) {
        const full = norm(p + '/' + path);
        for (const method of methods) routes.push({ method, full, segs: full.split('/').filter(Boolean), file: f.rel, line: lineOf(f.src, m.index!) });
      }
    }
  }
  return routes;
}

// os.environ['X'] — обязательная; os.environ.get('X') / os.getenv('X') без запасного значения — тоже, с запасным — нет
export function findPyEnv(files: PyFile[]): PyEnv[] {
  const out: PyEnv[] = [];
  for (const f of files) {
    for (const m of f.src.matchAll(/os\.environ\s*\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g)) {
      out.push({ name: m[2], rel: f.rel, line: lineOf(f.src, m.index!), required: true });
    }
    for (const m of f.src.matchAll(/os\.(?:environ\.get|getenv)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const args = balanced(f.src, open)?.text ?? '';
      const name = /^\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*(,|$)/.exec(args);
      if (!name) continue;
      out.push({ name: name[2], rel: f.rel, line: lineOf(f.src, m.index!), required: name[3] !== ',' });
    }
  }
  return out;
}
