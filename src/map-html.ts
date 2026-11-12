// Вёрстка вкладки «Карта проекта». Внутри скрипта намеренно нет обратных кавычек и ${ — это шаблонная строка.
export function mapHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Карта проекта</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --c-page: #4daafc; --c-style: #c586c0; --c-script: #dcdcaa; --c-server: #4ec9b0; --c-table: #ce9178; --c-external: #f48771;
    --line: var(--vscode-panel-border, #3c3c3c);
    --card: var(--vscode-editorWidget-background, #252526);
    --lane: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  }
  body {
    margin: 0; padding: 16px 20px 28px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); }
  button {
    font: inherit; border: 0; border-radius: 4px; padding: 4px 11px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  kbd {
    font: 11px var(--vscode-editor-font-family); padding: 1px 6px; border-radius: 4px;
    border: 1px solid var(--line); background: var(--card);
  }

  details.help { border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; margin-bottom: 12px; background: var(--lane); }
  details.help summary { cursor: pointer; font-weight: 600; }
  .legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px 18px; margin-top: 10px; }
  .legend div { display: flex; gap: 8px; align-items: center; }
  .ic {
    width: 24px; height: 24px; border-radius: 6px; flex: none; display: grid; place-items: center;
    color: var(--k); background: color-mix(in srgb, var(--k) 20%, transparent);
  }

  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 14px; align-items: start; }
  @media (max-width: 1050px) { .layout { grid-template-columns: 1fr; } }

  /* окно-камера: внутри карта, которую можно двигать и масштабировать */
  .stagewrap {
    position: relative; overflow: hidden; height: calc(100vh - 215px); min-height: 360px;
    border: 1px solid var(--line); border-radius: 12px; background-color: var(--vscode-editor-background);
    background-image: radial-gradient(circle, color-mix(in srgb, var(--vscode-foreground) 16%, transparent) 1px, transparent 1.3px);
    background-size: 24px 24px;
    cursor: grab; user-select: none; touch-action: none;
  }
  .stagewrap.panning, .stagewrap.panning * { cursor: grabbing !important; }
  .stagewrap.space .node { cursor: grab; }
  #world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  #heads { position: absolute; left: 0; top: 0; height: 58px; }
  .lh { position: absolute; top: 9px; display: flex; gap: 9px; align-items: center; padding-left: 10px; }
  .lh .ic { width: 32px; height: 32px; border-radius: 9px; }
  .lh b { display: block; font-size: 13px; }
  .lh small { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.2; }
  #stage { position: absolute; left: 0; top: 64px; }
  #lines { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 1; }

  .cam {
    position: absolute; right: 10px; top: 10px; z-index: 20; display: flex; gap: 4px; align-items: center; cursor: default;
    padding: 4px; border: 1px solid var(--line); border-radius: 9px;
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
  }
  .cam button { padding: 3px 9px; }
  .cam .zoom { min-width: 40px; text-align: center; font-size: 11px; }
  .hint {
    position: absolute; left: 10px; bottom: 20px; z-index: 20; max-width: calc(100% - 20px); pointer-events: none;
    font-size: 11px; line-height: 1.6; color: var(--vscode-descriptionForeground);
    padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line);
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
  }

  /* ручка внизу окна: тянешь вверх-вниз — окно карты выше или ниже */
  .grip {
    position: absolute; left: 0; right: 0; bottom: 0; height: 14px; z-index: 25;
    display: flex; align-items: center; justify-content: center; cursor: ns-resize; touch-action: none;
  }
  .grip::after { content: ''; width: 56px; height: 4px; border-radius: 3px; background: color-mix(in srgb, var(--vscode-foreground) 35%, transparent); }
  .grip:hover::after, .grip.on::after { background: var(--vscode-focusBorder, #0078d4); }

  /* режим «на весь экран»: карта занимает всю вкладку, описание блока всплывает поверх, когда блок выбран */
  body.full { overflow: hidden; padding: 0; }
  body.full header, body.full details.help, body.full .notes { display: none; }
  body.full .layout { display: block; }
  body.full .stagewrap { position: fixed; inset: 0; height: auto; min-height: 0; z-index: 50; border-radius: 0; border: 0; }
  body.full .grip { display: none; }
  body.full .panel {
    position: fixed; right: 14px; bottom: 14px; top: auto; width: 330px; max-height: 50vh; overflow: auto; z-index: 60;
    box-shadow: 0 10px 30px rgba(0, 0, 0, .5);
  }
  body.full .panel.idle { display: none; }
  body.nopanel .layout { grid-template-columns: 1fr; }
  body.nopanel:not(.full) .panel { display: none; }

  .lane { position: absolute; top: 10px; border: 1px solid var(--line); border-radius: 14px; background: var(--lane); }
  .grp {
    position: absolute; display: flex; align-items: center; gap: 8px;
    font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground);
  }
  .grp::after { content: ''; flex: 1; height: 1px; background: var(--line); }

  .node {
    position: absolute; z-index: 2; height: 38px; padding: 0 8px 0 6px; display: flex; align-items: center; gap: 8px;
    text-align: left; color: var(--vscode-foreground); background: var(--card); cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--k) 40%, var(--line)); border-radius: 9px;
    transition: opacity .15s, box-shadow .15s, border-color .15s;
  }
  .node:hover { border-color: var(--k); background: var(--card); }
  .node .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .node .mt {
    flex: none; font-size: 11px; font-style: normal; padding: 1px 8px; border-radius: 10px;
    color: var(--vscode-foreground); background: color-mix(in srgb, var(--k) 20%, transparent);
  }
  .node.on { border-color: var(--k); }
  .node.sel { border-color: var(--k); box-shadow: 0 0 0 2px color-mix(in srgb, var(--k) 55%, transparent), 0 8px 18px rgba(0, 0, 0, .35); z-index: 4; }
  .node.dim { opacity: .3; }

  /* таблицы БД рисуем как маленькие таблички: шапка с названием и строки под ней */
  .node.tbl { height: 46px; padding: 0; gap: 0; flex-direction: column; align-items: stretch; overflow: hidden; }
  .tbl .th {
    display: flex; align-items: center; gap: 7px; height: 25px; padding: 0 8px 0 6px;
    background: color-mix(in srgb, var(--k) 18%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--k) 40%, var(--line));
  }
  .tbl .th .ic { width: 16px; height: 16px; border-radius: 4px; background: none; }
  .tbl .th .lb { font-weight: 600; }
  .tbl .rows {
    flex: 1;
    background-image:
      linear-gradient(to right, transparent 34%, color-mix(in srgb, var(--vscode-foreground) 14%, transparent) 34%, color-mix(in srgb, var(--vscode-foreground) 14%, transparent) calc(34% + 1px), transparent calc(34% + 1px)),
      repeating-linear-gradient(to bottom, transparent 0, transparent 6px, color-mix(in srgb, var(--vscode-foreground) 10%, transparent) 6px, color-mix(in srgb, var(--vscode-foreground) 10%, transparent) 7px);
  }

  g.e { transition: opacity .15s; }
  g.e.dim { opacity: .05 !important; }
  g.e.on { opacity: .95 !important; }

  .panel { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; position: sticky; top: 8px; background: var(--lane); }
  .panel .title { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .panel h2 { font-size: 15px; margin: 0; word-break: break-all; }
  .panel .kind { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .panel p { margin: 6px 0; line-height: 1.5; }
  .panel h3 { font-size: 11px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  .panel ul { margin: 0; padding: 0; list-style: none; }
  .panel li { padding: 3px 0; }
  .taglist { display: flex; flex-wrap: wrap; gap: 5px 6px; }
  .taglist a, .taglist span {
    font: 11.5px var(--vscode-editor-font-family); padding: 1px 7px; border-radius: 6px;
    border: 1px solid var(--line); background: var(--card);
  }
  .panel { max-height: calc(100vh - 40px); overflow: auto; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .notes { margin-top: 12px; font-size: 12px; }
  .empty { padding: 28px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <div>
    <h1>Карта проекта</h1>
    <div class="muted" id="sub">Читаю проект…</div>
  </div>
  <button data-cmd="refresh">Обновить</button>
</header>

<details class="help" open>
  <summary>Как читать эту карту</summary>
  <p class="muted" style="margin:6px 0 0">Слева направо — путь от того, что видит человек, до того, где хранятся данные. Нажми на любой блок: подсветится вся цепочка, а справа простыми словами написано, что это и с чем связано.</p>
  <p class="muted" style="margin:6px 0 0"><b>Управление, как в игре:</b> колёсико — приблизить и отдалить; двигать карту — зажать правую кнопку мыши (или колёсико, или <kbd>Пробел</kbd> и мышь), либо просто потянуть за пустое место; <kbd>F</kbd> — вписать всё; <kbd>+</kbd> и <kbd>−</kbd> — масштаб; двойной клик по пустому месту — вернуть вид.</p>
  <div class="legend" id="legend"></div>
</details>

<div class="layout">
  <div class="stagewrap" id="wrap">
    <div id="world"><div id="heads"></div><div id="stage"></div></div>
    <div class="cam" id="cam">
      <button data-cam="in" title="Приблизить (+)">+</button>
      <button data-cam="out" title="Отдалить (−)">−</button>
      <span class="zoom muted" id="zoom">100%</span>
      <button data-cam="fit" title="Вписать всё (F)">Вписать</button>
      <button data-cam="reset" title="Масштаб 100% (1)">100%</button>
      <button data-cam="panel" id="btnPanel" title="Скрыть или показать описание справа">Панель</button>
      <button data-cam="full" id="btnFull" title="Развернуть карту на всю вкладку (Z)">На весь экран</button>
    </div>
    <div class="hint">Колесо — масштаб · ПКМ / Пробел + мышь — двигать · F — вписать · Z — на весь экран · Esc — снять выбор</div>
    <div class="grip" id="grip" title="Потяни, чтобы изменить высоту окна (двойной клик — вернуть)"></div>
  </div>
  <aside class="panel" id="detail"></aside>
</div>
<div class="notes muted" id="notes"></div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var map = null, sel = null, pos = {}, byId = {}, outE = {}, inE = {}, svg = null;
  var wrap = document.getElementById('wrap');
  var world = document.getElementById('world');
  var stage = document.getElementById('stage');
  var heads = document.getElementById('heads');
  var detail = document.getElementById('detail');
  var zoomLabel = document.getElementById('zoom');

  // размеры «мира» не зависят от окна: окно — это камера, которая по нему ездит
  var W = 1180, WH = 600, TOPOFF = 64;
  var cam = { s: 1, x: 0, y: 0 }, camReady = false;
  // пока пользователь сам не двигал камеру, при изменении размера окна вписываем карту заново
  var touched = false;
  var MIN = 0.18, MAX = 2.6;

  function svgIcon(path) {
    return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var ICON = {
    page: svgIcon('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/><path d="M6 8.5h4M6 11h4"/>'),
    style: svgIcon('<rect x="2.5" y="2.5" width="11" height="4" rx="1"/><path d="M8 6.5v3"/><rect x="6.5" y="9.5" width="3" height="4.5" rx="1"/>'),
    script: svgIcon('<path d="M6 2.5C4.5 2.5 4.5 3.8 4.5 5.2S4 7.5 2.8 8c1.2.5 1.7 1.2 1.7 2.8S4.5 13.5 6 13.5M10 2.5c1.5 0 1.5 1.3 1.5 2.7S12 7.5 13.2 8c-1.2.5-1.7 1.2-1.7 2.8S11.5 13.5 10 13.5"/>'),
    server: svgIcon('<rect x="2.5" y="2.8" width="11" height="4.2" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.2" rx="1.2"/><path d="M5 4.9h.01M5 11.1h.01"/>'),
    table: svgIcon('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.4h11M2.5 9.7h11M7 3v10"/>'),
    external: svgIcon('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2.2 2.3 2.2 8.7 0 11M8 2.5c-2.2 2.3-2.2 8.7 0 11"/>')
  };
  var KIND = {
    page: { col: 0, name: 'Страница', short: 'страница', color: 'var(--c-page)' },
    style: { col: 1, name: 'Стиль (CSS)', short: 'стиль', color: 'var(--c-style)' },
    script: { col: 1, name: 'Скрипт (JS)', short: 'скрипт', color: 'var(--c-script)' },
    server: { col: 2, name: 'Серверный файл', short: 'сервер', color: 'var(--c-server)' },
    table: { col: 3, name: 'Таблица базы данных', short: 'таблица', color: 'var(--c-table)' },
    external: { col: 3, name: 'Внешний сервис', short: 'сервис', color: 'var(--c-external)' }
  };
  var EDGE_COLOR = { includes: '#7a8ba0', calls: '#4daafc', stores: '#4ec9b0', talks: '#f48771' };
  var HEADS = [
    { t: '1. Страницы', s: 'что открывает пользователь', k: 'page' },
    { t: '2. Оформление и скрипты', s: 'как выглядит и что делает', k: 'script' },
    { t: '3. Сервер', s: 'принимает запросы и отвечает', k: 'server' },
    { t: '4. Данные', s: 'база и внешние сервисы', k: 'table' }
  ];
  var LEGEND = [
    ['page', 'Страница', 'то, что браузер открывает по адресу (HTML)'],
    ['style', 'Стиль', 'как всё выглядит: цвета, шрифты, отступы (CSS)'],
    ['script', 'Скрипт', 'что происходит в браузере по клику (JS)'],
    ['server', 'Сервер', 'принимает запросы от сайта и отвечает'],
    ['table', 'Таблица', 'где в базе хранятся данные'],
    ['external', 'Внешний сервис', 'чужая служба в интернете (Telegram, почта…)']
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------- камера ----------

  // не даём унести карту целиком за экран: всегда остаётся кусок
  function limit() {
    var vw = wrap.clientWidth, vh = wrap.clientHeight, keep = 90;
    cam.x = clamp(cam.x, keep - W * cam.s, vw - keep);
    cam.y = clamp(cam.y, keep - WH * cam.s, vh - keep);
  }
  function apply(anim) {
    limit();
    world.style.transition = anim ? 'transform .35s cubic-bezier(.2,.8,.2,1)' : 'none';
    world.style.transform = 'translate(' + cam.x + 'px,' + cam.y + 'px) scale(' + cam.s + ')';
    // точечная сетка на фоне едет вместе с камерой
    var g = Math.max(10, Math.round(24 * cam.s));
    wrap.style.backgroundSize = g + 'px ' + g + 'px';
    wrap.style.backgroundPosition = cam.x + 'px ' + cam.y + 'px';
    zoomLabel.textContent = Math.round(cam.s * 100) + '%';
  }
  function fit(whole, anim) {
    // сверху оставляем место под панель кнопок, чтобы она не закрывала заголовки колонок
    var vw = wrap.clientWidth, vh = wrap.clientHeight, pad = 24, top = 58;
    var sx = (vw - pad * 2) / W, sy = (vh - top - pad) / WH;
    cam.s = clamp(whole ? Math.min(sx, sy) : Math.min(1, sx), MIN, MAX);
    cam.x = (vw - W * cam.s) / 2;
    cam.y = whole ? top + (vh - top - pad - WH * cam.s) / 2 : top;
    apply(anim);
  }
  // масштаб к точке экрана (cx, cy): она остаётся на месте, как в картах и играх
  function zoomAt(cx, cy, f, anim) {
    var r = wrap.getBoundingClientRect();
    var px = cx - r.left, py = cy - r.top;
    var ns = clamp(cam.s * f, MIN, MAX);
    f = ns / cam.s;
    touched = true;
    cam.x = px - (px - cam.x) * f;
    cam.y = py - (py - cam.y) * f;
    cam.s = ns;
    apply(anim);
  }
  function zoomCenter(f, anim) {
    var r = wrap.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, f, anim);
  }
  // плавно перелететь к блоку
  function focusNode(id) {
    var p = pos[id];
    if (!p) return;
    if (cam.s < 0.7) cam.s = 0.7;
    touched = true;
    cam.x = wrap.clientWidth / 2 - (p.x + p.w / 2) * cam.s;
    cam.y = wrap.clientHeight / 2 - (TOPOFF + p.y + p.h / 2) * cam.s;
    apply(true);
  }

  var drag = null, space = false;
  wrap.addEventListener('pointerdown', function (e) {
    if (e.target.closest('#cam') || e.target.closest('#grip')) return;
    var onNode = e.target.closest('.node');
    // двигаем: правой / средней кнопкой, Пробел + левая, либо левой по пустому месту
    var pan = e.button === 1 || e.button === 2 || (e.button === 0 && (space || !onNode));
    if (!pan) return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, button: e.button, id: e.pointerId };
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* синтетическое событие без указателя */ }
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; touched = true; wrap.classList.add('panning'); }
    if (drag.moved) { cam.x = drag.cx + dx; cam.y = drag.cy + dy; apply(false); }
  });
  function endDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;
    wrap.classList.remove('panning');
    try { wrap.releasePointerCapture(d.id); } catch (err) { /* ничего */ }
    // просто клик по пустому месту — снять выбор
    if (!d.moved && d.button === 0 && sel) { sel = null; paint(); }
  }
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
  wrap.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  wrap.addEventListener('auxclick', function (e) { e.preventDefault(); });
  wrap.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });
  wrap.addEventListener('wheel', function (e) {
    if (e.target.closest('#cam')) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015), false);
  }, { passive: false });
  wrap.addEventListener('dblclick', function (e) {
    if (e.target.closest('.node') || e.target.closest('#cam') || e.target.closest('#grip')) return;
    fit(false, true);
  });

  // ---------- размер окна карты ----------
  var grip = document.getElementById('grip');
  var resizing = null;
  var saved = vscode.getState() || {};
  function saveState() { vscode.setState({ h: wrap.style.height || '', nopanel: document.body.classList.contains('nopanel') }); }
  function setHeight(h) {
    wrap.style.height = clamp(h, 240, 3000) + 'px';
    saveState();
  }
  grip.addEventListener('pointerdown', function (e) {
    resizing = { y: e.clientY, h: wrap.offsetHeight, id: e.pointerId };
    grip.classList.add('on');
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* синтетическое событие */ }
    e.preventDefault();
  });
  grip.addEventListener('pointermove', function (e) {
    if (resizing) setHeight(resizing.h + (e.clientY - resizing.y));
  });
  function endResize() {
    if (!resizing) return;
    try { grip.releasePointerCapture(resizing.id); } catch (err) { /* ничего */ }
    resizing = null;
    grip.classList.remove('on');
  }
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);
  grip.addEventListener('dblclick', function () { wrap.style.height = ''; saveState(); });

  function setFull(on) {
    document.body.classList.toggle('full', on);
    document.getElementById('btnFull').textContent = on ? 'Свернуть' : 'На весь экран';
  }
  function setPanel(show) {
    document.body.classList.toggle('nopanel', !show);
    saveState();
  }
  if (typeof saved.h === 'string' && saved.h) wrap.style.height = saved.h;
  if (saved.nopanel) document.body.classList.add('nopanel');

  // клавиши: Пробел (с мышью — двигать), +/− масштаб, F вписать, Esc снять выбор
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !map) return;
    var c = e.code;
    if (c === 'Space') { space = true; wrap.classList.add('space'); e.preventDefault(); return; }
    if (c === 'Equal' || c === 'NumpadAdd') { zoomCenter(1.2, true); }
    else if (c === 'Minus' || c === 'NumpadSubtract') { zoomCenter(1 / 1.2, true); }
    else if (c === 'KeyF' || c === 'Digit0') { fit(true, true); touched = true; }
    else if (c === 'Digit1') { zoomCenter(1 / cam.s, true); }
    else if (c === 'KeyZ') { setFull(!document.body.classList.contains('full')); }
    else if (c === 'Escape') {
      if (sel) { sel = null; paint(); }
      else if (document.body.classList.contains('full')) setFull(false);
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { space = false; wrap.classList.remove('space'); e.preventDefault(); }
  });
  window.addEventListener('blur', function () { space = false; wrap.classList.remove('space'); });

  // ---------- карта ----------

  function renderLegend() {
    document.getElementById('legend').innerHTML = LEGEND.map(function (l) {
      return '<div style="--k:' + KIND[l[0]].color + '"><span class="ic">' + ICON[l[0]] + '</span><span><b>' + l[1] + '</b> — ' + l[2] + '</span></div>';
    }).join('');
  }

  function layout() {
    var PAD = 11, NH = 38, TH = 46, NG = 8, GRP = 24, TOP = 20;
    var gap = Math.round(W * 0.05);
    var laneW = Math.floor((W - gap * 3) / 4);
    var nw = laneW - PAD * 2;
    var cols = [[], [], [], []];
    var GROUP = { style: 'Оформление (CSS)', script: 'Скрипты (JS)', table: 'Таблицы базы данных', external: 'Внешние сервисы' };
    ['page', 'style', 'script', 'server', 'table', 'external'].forEach(function (kind) {
      var list = map.nodes.filter(function (n) { return n.kind === kind; });
      if (!list.length) return;
      var col = KIND[kind].col;
      if (GROUP[kind]) cols[col].push({ group: GROUP[kind] });
      list.forEach(function (n) { cols[col].push({ node: n }); });
    });

    pos = {};
    var maxY = 0, lanesHtml = '', nodesHtml = '', headsHtml = '';
    for (var c = 0; c < 4; c++) {
      var lx = c * (laneW + gap);
      var y = TOP, first = true;
      cols[c].forEach(function (it) {
        if (it.group) {
          if (!first) y += 8;
          lanesHtml += '<div class="grp" style="left:' + (lx + PAD) + 'px;top:' + y + 'px;width:' + nw + 'px">' + it.group + '</div>';
          y += GRP;
        } else {
          var n = it.node, k = KIND[n.kind], isT = n.kind === 'table', h = isT ? TH : NH;
          pos[n.id] = { x: lx + PAD, y: y, w: nw, h: h };
          var meta = n.meta ? '<em class="mt">' + esc(n.meta) + '</em>' : '';
          nodesHtml += '<button class="node' + (isT ? ' tbl' : '') + '" data-id="' + esc(n.id) + '" title="' + esc(n.label) + '" style="--k:' + k.color + ';left:' + (lx + PAD) + 'px;top:' + y + 'px;width:' + nw + 'px">'
            + (isT
              ? '<span class="th"><span class="ic">' + ICON.table + '</span><span class="lb">' + esc(n.label) + '</span>' + meta + '</span><span class="rows"></span>'
              : '<span class="ic">' + ICON[n.kind] + '</span><span class="lb">' + esc(n.label) + '</span>' + meta)
            + '</button>';
          y += h + NG;
        }
        first = false;
      });
      if (y > maxY) maxY = y;
      headsHtml += '<div class="lh" style="left:' + lx + 'px;width:' + laneW + 'px;--k:' + KIND[HEADS[c].k].color + '"><span class="ic">' + ICON[HEADS[c].k] + '</span><span><b>' + HEADS[c].t + '</b><small>' + HEADS[c].s + '</small></span></div>';
    }
    var H = maxY + 18;
    for (var c2 = 0; c2 < 4; c2++) {
      lanesHtml = '<div class="lane" style="left:' + (c2 * (laneW + gap)) + 'px;width:' + laneW + 'px;height:' + (H - 20) + 'px"></div>' + lanesHtml;
    }

    WH = TOPOFF + H;
    world.style.width = W + 'px';
    world.style.height = WH + 'px';
    heads.style.width = W + 'px';
    heads.innerHTML = headsHtml;
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';

    var paths = '';
    map.edges.forEach(function (e, i) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      var x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
      var dx = Math.max(40, (x2 - x1) * 0.5);
      var w = Math.min(3.2, 1 + Math.log(e.count + 1) / Math.log(3));
      // в покое слабые связи почти не видны (их десятки), важные запросы ярче; при выборе блока цепочка подсвечивается
      var op = e.kind === 'calls' ? 0.5 : e.kind === 'includes' ? (e.indirect ? 0.14 : 0.5) : e.kind === 'stores' ? 0.14 : 0.28;
      var col = EDGE_COLOR[e.kind];
      paths += '<g class="e" data-i="' + i + '" style="opacity:' + op + '">'
        + '<path fill="none" stroke-linecap="round" d="M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ',' + (x2 - dx) + ' ' + y2 + ',' + x2 + ' ' + y2 + '" stroke="' + col + '" stroke-width="' + w + '"' + (e.indirect ? ' stroke-dasharray="4 4"' : '') + '/>'
        + '<circle cx="' + x1 + '" cy="' + y1 + '" r="3" fill="' + col + '"/><circle cx="' + x2 + '" cy="' + y2 + '" r="3" fill="' + col + '"/></g>';
    });
    stage.innerHTML = lanesHtml + '<svg id="lines" xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' + paths + '</svg>' + nodesHtml;
    svg = document.getElementById('lines');
    paint();
  }

  function index() {
    byId = {}; outE = {}; inE = {};
    map.nodes.forEach(function (n) { byId[n.id] = n; outE[n.id] = []; inE[n.id] = []; });
    map.edges.forEach(function (e) {
      if (outE[e.from]) outE[e.from].push(e);
      if (inE[e.to]) inE[e.to].push(e);
    });
  }

  // вся цепочка: вперёд (кого использует) и назад (кто использует)
  function chain(id) {
    var seen = {}; seen[id] = true;
    var q = [id];
    while (q.length) { var cur = q.pop(); (outE[cur] || []).forEach(function (e) { if (!seen[e.to]) { seen[e.to] = true; q.push(e.to); } }); }
    q = [id];
    while (q.length) { var cur2 = q.pop(); (inE[cur2] || []).forEach(function (e) { if (!seen[e.from]) { seen[e.from] = true; q.push(e.from); } }); }
    return seen;
  }

  function paint() {
    var on = sel ? chain(sel) : null;
    var nodes = stage.querySelectorAll('.node');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-id');
      var base = nodes[i].className.indexOf('tbl') >= 0 ? 'node tbl' : 'node';
      nodes[i].className = base + (on ? (on[id] ? ' on' : ' dim') : '') + (id === sel ? ' sel' : '');
    }
    var gs = svg.querySelectorAll('g.e');
    for (var j = 0; j < gs.length; j++) {
      var e = map.edges[Number(gs[j].getAttribute('data-i'))];
      gs[j].setAttribute('class', 'e' + (on ? (on[e.from] && on[e.to] ? ' on' : ' dim') : ''));
    }
    renderDetail();
  }

  function renderDetail() {
    detail.classList.toggle('idle', !sel);
    if (!sel) {
      var s = map.stats;
      detail.innerHTML = '<div class="title"><h2>Что здесь есть</h2></div><p>Страниц: <b>' + s.pages + '</b>, стилей: <b>' + s.styles + '</b>, скриптов: <b>' + s.scripts
        + '</b>. Серверных файлов: <b>' + s.servers + '</b> (адресов, которые они обслуживают: <b>' + s.routes + '</b>). Таблиц БД: <b>' + s.tables
        + '</b>, внешних сервисов: <b>' + s.externals + '</b>.</p><p class="muted">Нажми на любой блок: я покажу всю цепочку и объясню, что это.</p>'
        + '<p class="muted">Линии: сплошные — прямая связь, пунктир — страница подключает скрипт не напрямую, а через import. Число на карточке — сколько адресов (на сервере) или запросов (в скрипте); у таблиц и сервисов «×3» значит, что с ними работают три файла.</p>';
      return;
    }
    var n = byId[sel], k = KIND[n.kind];
    var h = '<div class="title" style="--k:' + k.color + '"><span class="ic">' + ICON[n.kind] + '</span><div><h2>' + esc(n.label) + '</h2><div class="kind">' + k.name + '</div></div></div>';
    n.text.forEach(function (t) { h += '<p>' + esc(t) + '</p>'; });
    (n.lists || []).forEach(function (l) {
      h += '<h3>' + esc(l.title) + '</h3><div class="taglist">';
      l.items.forEach(function (it) {
        h += it.file
          ? '<a data-cmd="openFinding" data-file="' + esc(it.file) + '" data-line="' + (it.line || 1) + '" title="' + esc(it.file) + ':' + (it.line || 1) + '">' + esc(it.label) + '</a>'
          : '<span>' + esc(it.label) + '</span>';
      });
      h += '</div>';
    });
    if (n.related && n.related.length) {
      h += '<h3>' + esc(n.relatedTitle || 'Связано') + '</h3><ul>';
      n.related.forEach(function (r) {
        var t = byId[r.id];
        if (t) h += '<li><a data-pick="' + esc(r.id) + '">' + esc(t.label) + '</a><span class="muted"> · ' + KIND[t.kind].short + ' · ' + esc(r.note) + '</span></li>';
      });
      h += '</ul>';
    }
    var outs = outE[sel] || [], ins = inE[sel] || [];
    function item(id, e) {
      var extra = e.kind === 'calls' ? e.count + ' запр.' : e.kind === 'includes' ? (e.indirect ? 'через import' : 'напрямую') : '';
      return '<li><a data-pick="' + esc(id) + '">' + esc(byId[id].label) + '</a><span class="muted"> · ' + KIND[byId[id].kind].short + (extra ? ' · ' + extra : '') + '</span></li>';
    }
    if (outs.length) {
      h += '<h3>Дальше по цепочке →</h3><ul>';
      outs.forEach(function (e) { h += item(e.to, e); });
      h += '</ul>';
    }
    if (ins.length) {
      h += '<h3>← Откуда приходят</h3><ul>';
      ins.forEach(function (e) { h += item(e.from, e); });
      h += '</ul>';
    }
    if (n.file) h += '<p style="margin-top:14px"><button class="primary" data-cmd="openFinding" data-file="' + esc(n.file) + '" data-line="' + (n.line || 1) + '">Открыть файл</button></p>';
    detail.innerHTML = h;
  }

  function render() {
    if (!map || !map.nodes.length) {
      heads.innerHTML = '';
      stage.innerHTML = '<div class="empty" style="width:520px">Показывать пока нечего. Карта строится по HTML-страницам и серверу на Express: добавь в проект страницу с подключёнными стилями и скриптами.</div>';
      detail.innerHTML = '';
      return;
    }
    index();
    if (sel && !byId[sel]) sel = null;
    layout();
    // первый раз — вписать по ширине; при обновлении карты камеру не трогаем
    if (!camReady) { fit(false, false); camReady = true; }
    var s = map.stats;
    document.getElementById('sub').textContent = 'Страниц ' + s.pages + ' · стилей ' + s.styles + ' · скриптов ' + s.scripts + ' · серверных файлов ' + s.servers + ' · таблиц ' + s.tables + ' · внешних сервисов ' + s.externals;
    document.getElementById('notes').innerHTML = map.notes.map(function (t) { return '<div>• ' + esc(t) + '</div>'; }).join('');
  }

  document.addEventListener('click', function (e) {
    var cb = e.target.closest('[data-cam]');
    if (cb) {
      var a = cb.getAttribute('data-cam');
      if (a === 'in') zoomCenter(1.25, true);
      else if (a === 'out') zoomCenter(1 / 1.25, true);
      else if (a === 'fit') { fit(true, true); touched = true; }
      else if (a === 'reset') zoomCenter(1 / cam.s, true);
      else if (a === 'full') setFull(!document.body.classList.contains('full'));
      else if (a === 'panel') setPanel(document.body.classList.contains('nopanel'));
      cb.blur();
      return;
    }
    var node = e.target.closest('.node');
    if (node) {
      var id = node.getAttribute('data-id');
      sel = sel === id ? null : id;
      node.blur(); // иначе Пробел «нажимал» бы эту кнопку
      paint();
      return;
    }
    var pick = e.target.closest('[data-pick]');
    if (pick) { sel = pick.getAttribute('data-pick'); paint(); focusNode(sel); return; }
    var b = e.target.closest('[data-cmd]');
    if (b) {
      e.preventDefault();
      vscode.postMessage({ cmd: b.getAttribute('data-cmd'), file: b.getAttribute('data-file') || '', line: Number(b.getAttribute('data-line')) || 0 });
    }
  });

  // размер окна поменялся (в том числе при первом показе): не тронутую камеру вписываем заново, тронутую просто поджимаем
  new ResizeObserver(function () {
    if (!map || !map.nodes.length) return;
    if (touched) apply(false); else fit(false, false);
  }).observe(wrap);

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'map') { map = m.map; render(); }
    else if (m.type === 'error') { document.getElementById('sub').textContent = 'Не получилось построить карту: ' + m.message; }
  });

  renderLegend();
  vscode.postMessage({ cmd: 'ready' });
})();
</script>
</body>
</html>`;
}
