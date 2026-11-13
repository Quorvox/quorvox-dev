import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { findPyRoutes, findPyEnv } from '../src/pyroutes.ts';
import { analyzeProject } from '../src/checks.ts';

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 150 } as const;
const routesOf = (files: Record<string, string>) => findPyRoutes(Object.entries(files).map(([rel, src]) => ({ rel, src }))).map((r) => `${r.method} ${r.full}`).sort();

test('Flask: route, методы, параметры <int:id>, Blueprint с url_prefix', () => {
  const r = routesOf({
    'app.py': [
      'from flask import Flask',
      'from api import bp',
      'app = Flask(__name__)',
      "app.register_blueprint(bp, url_prefix='/api')",
      "@app.route('/')",
      'def home(): pass',
      "@app.route('/login', methods=['GET', 'POST'])",
      'def login(): pass',
      "@app.get('/health')",
      'def health(): pass',
      '',
    ].join('\n'),
    'api.py': ['from flask import Blueprint', "bp = Blueprint('api', __name__, url_prefix='/v1')", "@bp.route('/users/<int:user_id>')", 'def u(user_id): pass', "@bp.post('/users')", 'def c(): pass', ''].join('\n'),
  });
  // префикс при регистрации заменяет собственный префикс Blueprint (так делает Flask)
  assert.deepEqual(r, ['GET /', 'GET /api/users/:user_id', 'GET /health', 'GET /login', 'POST /api/users', 'POST /login']);
});

test('FastAPI: APIRouter(prefix), include_router(prefix) складываются, {id} и вложенные роутеры', () => {
  const r = routesOf({
    'main.py': ['from fastapi import FastAPI', 'from routers import users', 'app = FastAPI()', "app.include_router(users.router, prefix='/api')", "@app.get('/ping')", 'def ping(): pass', ''].join('\n'),
    'routers/users.py': ['from fastapi import APIRouter', "router = APIRouter(prefix='/users', tags=['u'])", "@router.get('/{user_id}')", 'def g(user_id: int): pass', "@router.delete('/{user_id}/photos/{name:path}')", 'def d(): pass', ''].join('\n'),
  });
  assert.deepEqual(r, ['DELETE /api/users/:user_id/photos/:name', 'GET /api/users/:user_id', 'GET /ping']);
});

test('роутер, который нигде не подключён, считаем подключённым со своим префиксом (без ложных «нет маршрута»)', () => {
  const r = routesOf({ 'x.py': ["router = APIRouter(prefix='/x')", "@router.get('/a')", 'def a(): pass', ''].join('\n') });
  assert.deepEqual(r, ['GET /x/a']);
});

test('переменные окружения Python: os.environ[], os.getenv, os.environ.get с запасным значением и без', () => {
  const env = findPyEnv([{ rel: 'a.py', src: ["import os", "A = os.environ['DB_URL']", "B = os.getenv('PORT', '8000')", "C = os.environ.get('SECRET')", "D = os.getenv(name)", ''].join('\n') }]);
  const by = Object.fromEntries(env.map((e) => [e.name, e.required]));
  assert.deepEqual(by, { DB_URL: true, PORT: false, SECRET: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'qv-py-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

test('проверки: фронт зовёт адрес Flask-сервера — найден, опечатка — предупреждение, неверный метод — ошибка', () => {
  const root = project({
    'app.py': ['from flask import Flask', 'app = Flask(__name__)', "@app.route('/api/items')", 'def items(): pass', "@app.route('/api/items/<int:id>', methods=['DELETE'])", 'def rm(id): pass', ''].join('\n'),
    'static/app.js': ["fetch('/api/items');", "fetch('/api/itemz');", "fetch('/api/items/5', { method: 'GET' });", ''].join('\n'),
    'static/index.html': '<script src="app.js"></script>',
  });
  try {
    const rep = analyzeProject(root, []);
    const route = rep.findings.filter((f) => f.kind === 'route').map((f) => f.message);
    assert.equal(route.length, 1, JSON.stringify(rep.findings.map((f) => f.message)));
    assert.match(route[0], /itemz/);
    assert.ok(rep.findings.some((f) => f.kind === 'method' && /5/.test(f.message)), 'нет ошибки про неверный метод');
    assert.equal(rep.stats.routes, 2);
  } finally {
    rmSync(root, RM);
  }
});

test('запуск: Flask и FastAPI определяются, venv подхватывается, у Node-проекта Python не добавляется', async () => {
  const { detectServices } = await import('../src/detect.ts');
  const flask = project({ 'app.py': 'from flask import Flask\napp = Flask(__name__)\n', 'requirements.txt': 'flask\n' });
  const fast = project({ 'backend/main.py': 'from fastapi import FastAPI\napi = FastAPI()\n', 'backend/.venv/Scripts/python.exe': '', 'backend/.venv/bin/python': '' });
  const node = project({ 'package.json': JSON.stringify({ scripts: { start: 'node a.js' } }), 'app.py': 'app = Flask(__name__)\n' });
  try {
    const f = detectServices(flask);
    assert.equal(f.length, 1);
    assert.match(f[0].command, /-m flask --app app:app run --debug --port 5000$/);
    const g = detectServices(fast);
    assert.equal(g.length, 1);
    assert.match(g[0].command, /-m uvicorn main:api --reload --port 8000$/);
    assert.ok(/\.venv/.test(g[0].command), 'venv не подхвачен: ' + g[0].command);
    assert.equal(detectServices(node).length, 1);
    assert.match(detectServices(node)[0].command, /npm run start/);
  } finally {
    for (const d of [flask, fast, node]) rmSync(d, RM);
  }
});
