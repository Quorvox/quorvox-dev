// Вёрстка дашборда. Внутри скрипта намеренно нет обратных кавычек и ${ — это шаблонная строка.
export function dashboardHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Quorvox</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 20px; height: 100vh;
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: center; }
  button {
    font: inherit; border: 0; border-radius: 4px; padding: 4px 11px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  #cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .card {
    border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .top { display: flex; align-items: center; gap: 8px; }
  .st { margin-left: auto; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #888; flex: none; }
  .dot.running { background: #3fb950; box-shadow: 0 0 6px #3fb95099; }
  .dot.crashed { background: #f85149; }
  .muted { color: var(--vscode-descriptionForeground); }
  .mono { font-family: var(--vscode-editor-font-family); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btns { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  a { color: var(--vscode-textLink-foreground); }
  .logs { flex: 1; min-height: 160px; display: flex; flex-direction: column; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  .chip { padding: 2px 10px; border-radius: 10px; }
  .chip.on { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .grow { flex: 1; }
  input {
    font: inherit; min-width: 140px; padding: 3px 8px; border-radius: 4px; outline: none;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent);
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  #log { flex: 1; overflow: auto; padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.55; }
  .ln { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-all; }
  .tm { color: var(--vscode-descriptionForeground); flex: none; }
  .nm { flex: none; min-width: 72px; }
  .ln.err .tx { color: var(--vscode-errorForeground); }
  .ln.warn .tx { color: var(--vscode-editorWarning-foreground); }
  .ln.sys .tx { color: var(--vscode-textLink-foreground); font-style: italic; }
  .empty { padding: 14px; color: var(--vscode-descriptionForeground); }
  .banner {
    display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; margin-bottom: 14px; padding: 10px 14px; border-radius: 10px;
    border: 1px solid #3fb950; background: color-mix(in srgb, #3fb950 12%, transparent);
  }
  .banner[hidden] { display: none; }
  .banner .txt { flex: 1; min-width: 240px; line-height: 1.45; }
  .modal { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .55); }
  .modal[hidden] { display: none; }
  .sheet {
    width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 18px 20px; border-radius: 12px;
    background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-panel-border); box-shadow: 0 12px 40px rgba(0, 0, 0, .5);
  }
  .sheet h2 { margin: 0 0 12px; font-size: 16px; }
  .qr { width: 220px; height: 220px; margin: 0 auto 10px; padding: 8px; background: #fff; border-radius: 10px; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .qrurl { text-align: center; font-family: var(--vscode-editor-font-family); font-size: 12px; margin-bottom: 8px; word-break: break-all; }
  .sheet ol { margin: 8px 0; padding-left: 20px; line-height: 1.5; }
  .warnbox { margin: 8px 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.45; color: var(--vscode-editorWarning-foreground); border: 1px solid var(--vscode-editorWarning-foreground); }
  #checks { margin-bottom: 14px; }
  .chk { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 12px; }
  .chk h2 { font-size: 13px; margin: 0 0 6px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .chk .item { display: flex; gap: 8px; padding: 3px 0; align-items: baseline; }
  .chk .sev { flex: none; width: 14px; text-align: center; }
  .chk .sev.error { color: var(--vscode-errorForeground); }
  .chk .sev.warn { color: var(--vscode-editorWarning-foreground); }
  .chk .sev.info { color: var(--vscode-descriptionForeground); }
  .chk .where { margin-left: auto; flex: none; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .cnt { white-space: nowrap; }
  .cnt.error { color: var(--vscode-errorForeground); }
  .cnt.warn { color: var(--vscode-editorWarning-foreground); }
  .ok { color: #3fb950; }
</style>
</head>
<body>
<header>
  <h1>Quorvox</h1>
  <div class="row">
    <button data-cmd="map">Карта проекта</button>
    <button data-cmd="deploy" title="Выложить проект на свой сервер (спросит подтверждение)">🚀 Выложить</button>
    <button class="primary" data-cmd="startAll">▶ Запустить всё</button>
    <button data-cmd="stopAll">■ Остановить всё</button>
  </div>
</header>
<div id="release" class="banner" hidden></div>
<div id="qrbox" class="modal" hidden></div>
<section id="cards"></section>
<section id="checks"></section>
<section class="logs">
  <div class="bar">
    <span id="chips" class="row"></span>
    <span class="grow"></span>
    <input id="search" type="search" placeholder="Поиск по логам">
    <button data-cmd="clear">Очистить</button>
  </div>
  <div id="log"></div>
</section>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var MAX = 3000;
  var services = [], lines = [], filter = null, search = '', follow = true, checks = null;
  var cardsEl = document.getElementById('cards');
  var logEl = document.getElementById('log');
  var chipsEl = document.getElementById('chips');
  var STATUS = { running: 'запущен', crashed: 'упал', stopped: 'остановлен' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hue(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function cls(text) {
    if (/^(перезапуск:|остановлен( \\(|$)|live-reload:|слишком частые|не запустилось)/.test(text)) return 'sys';
    if (/(error|ERR!|exception|failed|fatal|ошибка)/i.test(text)) return 'err';
    if (/warn(ing)?/i.test(text)) return 'warn';
    return '';
  }

  function renderCards() {
    if (!services.length) {
      cardsEl.innerHTML = '<p class="muted">В этой папке нет проекта для запуска. Подойдёт: package.json со скриптом dev или start, страница index.html (запущу как сайт) или файл quorvox.json. Если это не веб-проект, так и должно быть.</p>';
      return;
    }
    cardsEl.innerHTML = services.map(function (s) {
      var n = esc(s.name);
      var on = s.status !== 'stopped';
      return '<div class="card">'
        + '<div class="top"><span class="dot ' + s.status + '"></span><b>' + n + '</b><span class="st">' + STATUS[s.status] + '</span></div>'
        + '<div class="muted mono" title="' + esc(s.command) + '">' + esc(s.command) + '</div>'
        + '<div class="muted mono">' + esc(s.dir) + (s.autoRestart ? ' · автоперезапуск' : '') + '</div>'
        + (s.url ? '<div><a href="#" data-cmd="open" data-name="' + n + '">' + esc(s.url) + '</a> <span class="muted">· обновляется само</span></div>' : '')
        + (s.lan ? '<div class="muted">📱 в сети: <a href="#" data-cmd="phone" data-name="' + n + '">' + esc(s.lan) + '</a></div>' : '')
        + '<div class="btns">'
        + (on
          ? '<button data-cmd="restart" data-name="' + n + '">↻ Рестарт</button><button data-cmd="stop" data-name="' + n + '">■ Стоп</button>'
          : '<button class="primary" data-cmd="start" data-name="' + n + '">▶ Старт</button>')
        + (s.url ? (s.lan
          ? '<button data-cmd="phoneOff" data-name="' + n + '" title="Закрыть доступ из Wi-Fi сети">📱 Выключить</button>'
          : '<button data-cmd="phone" data-name="' + n + '" title="Открыть сайт на телефоне по QR-коду">📱 Телефон</button>') : '')
        + '<button data-cmd="filter" data-name="' + n + '">Логи</button>'
        + '</div></div>';
    }).join('');
  }

  var SEV = { error: '✖', warn: '▲', info: 'i' };
  function renderChecks() {
    var el = document.getElementById('checks');
    if (!checks) { el.innerHTML = ''; return; }
    var head = '<h2>Проверки'
      + (checks.errors ? ' <span class="cnt error">ошибок: ' + checks.errors + '</span>' : '')
      + (checks.warns ? ' <span class="cnt warn">предупреждений: ' + checks.warns + '</span>' : '')
      + ' <span class="muted">маршрутов ' + checks.stats.routes + ' · запросов фронта ' + checks.stats.calls
      + '</span> <button data-cmd="recheck">Проверить снова</button></h2>';
    if (!checks.findings.length) {
      el.innerHTML = '<div class="chk">' + head + '<div class="ok">✓ Проблем не найдено</div></div>';
      return;
    }
    var items = checks.findings.map(function (f) {
      var where = f.file ? esc(f.file) + (f.line ? ':' + f.line : '') : '';
      var inner = '<span class="sev ' + f.severity + '">' + SEV[f.severity] + '</span><span>' + esc(f.message) + '</span>'
        + (where ? '<a class="where" href="#" data-cmd="openFinding" data-file="' + esc(f.file) + '" data-line="' + (f.line || 1) + '">' + where + '</a>' : '');
      return '<div class="item">' + inner + '</div>';
    }).join('');
    var more = checks.total > checks.findings.length ? '<div class="muted">…и ещё ' + (checks.total - checks.findings.length) + '</div>' : '';
    el.innerHTML = '<div class="chk">' + head + items + more + '</div>';
  }

  function renderChips() {
    var html = '<button class="chip' + (filter ? '' : ' on') + '" data-cmd="filter" data-name="">Все</button>';
    services.forEach(function (s) {
      html += '<button class="chip' + (filter === s.name ? ' on' : '') + '" data-cmd="filter" data-name="' + esc(s.name) + '">' + esc(s.name) + '</button>';
    });
    chipsEl.innerHTML = html;
  }

  function visible(l) {
    return (!filter || l.name === filter) && (!search || l.text.toLowerCase().indexOf(search) >= 0);
  }

  function lineEl(l) {
    var d = document.createElement('div');
    d.className = 'ln ' + cls(l.text);
    var t = new Date(l.t);
    d.innerHTML = '<span class="tm">' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + '</span>'
      + '<span class="nm" style="color:hsl(' + hue(l.name) + ',60%,62%)">' + esc(l.name) + '</span>'
      + '<span class="tx">' + esc(l.text) + '</span>';
    return d;
  }

  function scrollDown() { if (follow) logEl.scrollTop = logEl.scrollHeight; }

  function renderLog() {
    logEl.innerHTML = '';
    var shown = lines.filter(visible).slice(-MAX);
    if (!shown.length) {
      logEl.innerHTML = '<div class="empty">Логов пока нет. Нажми «Запустить всё».</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    shown.forEach(function (l) { frag.appendChild(lineEl(l)); });
    logEl.appendChild(frag);
    follow = true;
    scrollDown();
  }

  function addLines(list) {
    var empty = logEl.querySelector('.empty');
    list.forEach(function (l) {
      lines.push(l);
      if (!visible(l)) return;
      if (empty) { logEl.innerHTML = ''; empty = null; }
      logEl.appendChild(lineEl(l));
    });
    if (lines.length > MAX) lines.splice(0, lines.length - MAX);
    while (logEl.childElementCount > MAX) logEl.removeChild(logEl.firstChild);
    scrollDown();
  }

  logEl.addEventListener('scroll', function () {
    follow = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  });

  document.getElementById('search').addEventListener('input', function (e) {
    search = e.target.value.toLowerCase();
    renderLog();
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cmd]');
    if (!b) return;
    e.preventDefault();
    var cmd = b.getAttribute('data-cmd');
    var name = b.getAttribute('data-name') || '';
    if (cmd === 'qrClose') { qrbox.hidden = true; return; }
    if (cmd === 'phoneOff') qrbox.hidden = true;
    if (cmd === 'filter') { filter = name || null; renderChips(); renderLog(); return; }
    if (cmd === 'clear') { lines = []; renderLog(); }
    vscode.postMessage({ cmd: cmd, name: name, file: b.getAttribute('data-file') || '', line: Number(b.getAttribute('data-line')) || 0 });
  });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'init') {
      services = m.services; lines = m.lines; checks = m.checks;
      showRelease(m.release);
      if (m.filter) filter = m.filter;
      renderCards(); renderChecks(); renderChips(); renderLog();
    } else if (m.type === 'state') {
      services = m.services; checks = m.checks; renderCards(); renderChecks(); renderChips();
    } else if (m.type === 'log') {
      addLines(m.lines);
    } else if (m.type === 'filter') {
      filter = m.name || null; renderChips(); renderLog();
    } else if (m.type === 'qr') {
      showQr(m);
    } else if (m.type === 'release') {
      showRelease(m.release);
    }
  });

  // плашка после выкладки: старая версия сохранена на сервере, решение за человеком
  var relbox = document.getElementById('release');
  function showRelease(r) {
    if (!r) { relbox.hidden = true; return; }
    var d = new Date(r.at);
    var hh = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    relbox.innerHTML = '<div class="txt">🚀 Выложено на <b>' + esc(r.host) + '</b> в ' + hh
      + '. Старая версия сохранена на сервере. <b>Всё работает?</b> Тогда подтверди: копия старой версии удалится. Не так — откати.</div>'
      + '<button class="primary" data-cmd="releaseOk">✔ Работает, удалить копию</button>'
      + '<button data-cmd="releaseUndo">↩ Откатить</button>';
    relbox.hidden = false;
  }

  // окно «Открыть на телефоне»: QR-картинку строит расширение, сюда приходит готовый SVG
  var qrbox = document.getElementById('qrbox');
  function showQr(m) {
    if (!m.open) { qrbox.hidden = true; return; }
    qrbox.innerHTML = '<div class="sheet">'
      + '<h2>Открыть на телефоне</h2>'
      + '<div class="qr">' + m.svg + '</div>'
      + '<div class="qrurl">' + esc(m.url) + '</div>'
      + '<ol class="muted"><li>Телефон должен быть в той же Wi-Fi сети, что и компьютер.</li>'
      + '<li>Наведи камеру на код и открой ссылку.</li>'
      + '<li>Страница на телефоне обновляется сама, а её ошибки появятся в логах здесь.</li></ol>'
      + '<p class="warnbox">Пока доступ включён, этот проект видят все устройства в вашей сети. Windows может спросить про брандмауэр: разреши для частной сети. При остановке сервисов доступ выключится сам.</p>'
      + '<div class="btns"><button data-cmd="phoneOff" data-name="' + esc(m.name) + '">Выключить доступ</button><button class="primary" data-cmd="qrClose">Закрыть</button></div>'
      + '</div>';
    qrbox.hidden = false;
  }

  vscode.postMessage({ cmd: 'ready' });
})();
</script>
</body>
</html>`;
}
