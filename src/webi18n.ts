import { getLang } from './i18n.ts';

// Перевод готовой вёрстки дашборда и карты (HTML + клиентский скрипт).
// Ключ — русский фрагмент в исходнике, подставляем английский. Длинные ключи заменяем раньше коротких.
// Тест проверяет, что после замены в вёрстке не осталось русских букв вне комментариев.

const WEB: Record<string, string> = {
  'lang="ru"': 'lang="en"',
  // общее
  'Карта проекта': 'Project map',
  // дашборд: шапка и кнопки
  'Выложить проект на свой сервер (спросит подтверждение)': 'Deploy the project to your own server (asks for confirmation)',
  '🚀 Выложить': '🚀 Deploy',
  '▶ Запустить всё': '▶ Start all',
  '■ Остановить всё': '■ Stop all',
  'Поиск по логам': 'Search logs',
  'Очистить': 'Clear',
  // дашборд: состояния и классификация строк лога
  "running: 'запущен', crashed: 'упал', stopped: 'остановлен'": "running: 'running', crashed: 'crashed', stopped: 'stopped'",
  '/^(перезапуск:|остановлен( \\(|$)|live-reload:|слишком частые|не запустилось)/': '/^(restart:|stopped( \\(|$)|live-reload:|too frequent|failed to start)/',
  '|ошибка)': '|fail)',
  'В этой папке нет проекта для запуска. Подойдёт: package.json со скриптом dev или start, страница index.html (запущу как сайт) или файл quorvox.json. Если это не веб-проект, так и должно быть.':
    'There is no runnable project in this folder. A package.json with a dev or start script, an index.html page (served as a site) or a quorvox.json file will do. If this is not a web project, that is expected.',
  ' · автоперезапуск': ' · auto-restart',
  '· обновляется само': '· refreshes by itself',
  '📱 в сети: ': '📱 on network: ',
  '↻ Рестарт': '↻ Restart',
  '■ Стоп': '■ Stop',
  '▶ Старт': '▶ Start',
  'Закрыть доступ из Wi-Fi сети': 'Close access from the Wi-Fi network',
  '📱 Выключить': '📱 Turn off',
  'Открыть сайт на телефоне по QR-коду': 'Open the site on your phone with a QR code',
  '📱 Телефон': '📱 Phone',
  '>Логи<': '>Logs<',
  // дашборд: проверки
  '<h2>Проверки': '<h2>Checks',
  'ошибок: ': 'errors: ',
  'предупреждений: ': 'warnings: ',
  'маршрутов ': 'routes ',
  ' · запросов фронта ': ' · front-end requests ',
  'Проверить снова': 'Check again',
  '✓ Проблем не найдено': '✓ No problems found',
  '…и ещё ': '…and another ',
  '>Все</button>': '>All</button>',
  'Логов пока нет. Нажми «Запустить всё».': 'No logs yet. Press «Start all».',
  // дашборд: плашка выкладки и телефон
  '🚀 Выложено на <b>': '🚀 Deployed to <b>',
  '</b> в ': '</b> at ',
  '. Старая версия сохранена на сервере. <b>Всё работает?</b> Тогда подтверди: копия старой версии удалится. Не так — откати.':
    '. The old version is kept on the server. <b>Does everything work?</b> Then confirm: the old version\'s copy will be deleted. If not, roll back.',
  '✔ Работает, удалить копию': '✔ Works, delete the copy',
  '↩ Откатить': '↩ Roll back',
  '<h2>Открыть на телефоне</h2>': '<h2>Open on your phone</h2>',
  'Телефон должен быть в той же Wi-Fi сети, что и компьютер.': 'The phone must be on the same Wi-Fi network as the computer.',
  'Наведи камеру на код и открой ссылку.': 'Point the camera at the code and open the link.',
  'Страница на телефоне обновляется сама, а её ошибки появятся в логах здесь.': 'The page on the phone refreshes by itself, and its errors will show up in the logs here.',
  'Пока доступ включён, этот проект видят все устройства в вашей сети. Windows может спросить про брандмауэр: разреши для частной сети. При остановке сервисов доступ выключится сам.':
    'While access is on, every device on your network can see this project. Windows may ask about the firewall: allow it for a private network. Access turns off by itself when services stop.',
  'Выключить доступ': 'Turn off access',
  '>Закрыть<': '>Close<',
  // карта: шапка
  'Читаю проект…': 'Reading the project…',
  '>Обновить<': '>Refresh<',
  'Как читать эту карту': 'How to read this map',
  'Слева направо — путь от того, что видит человек, до того, где хранятся данные. Нажми на любой блок: подсветится вся цепочка, а справа простыми словами написано, что это и с чем связано.':
    'Left to right: the path from what a person sees to where the data is stored. Click any block: the whole chain lights up, and on the right a plain explanation says what it is and what it is connected to.',
  '<b>Управление, как в игре:</b> колёсико — приблизить и отдалить; двигать карту — зажать правую кнопку мыши (или колёсико, или <kbd>Пробел</kbd> и мышь), либо просто потянуть за пустое место; <kbd>F</kbd> — вписать всё; <kbd>+</kbd> и <kbd>−</kbd> — масштаб; двойной клик по пустому месту — вернуть вид.':
    '<b>Controls, like in a game:</b> wheel — zoom in and out; to move the map hold the right mouse button (or the wheel, or <kbd>Space</kbd> and the mouse), or just drag an empty spot; <kbd>F</kbd> — fit everything; <kbd>+</kbd> and <kbd>−</kbd> — zoom; double-click an empty spot — reset the view.',
  'Приблизить (+)': 'Zoom in (+)',
  'Отдалить (−)': 'Zoom out (−)',
  'Вписать всё (F)': 'Fit everything (F)',
  '>Вписать<': '>Fit<',
  'Масштаб 100% (1)': 'Zoom 100% (1)',
  'Скрыть или показать описание справа': 'Hide or show the description on the right',
  '>Панель<': '>Panel<',
  'Развернуть карту на всю вкладку (Z)': 'Expand the map to the whole tab (Z)',
  '>На весь экран<': '>Full screen<',
  'Колесо — масштаб · ПКМ / Пробел + мышь — двигать · F — вписать · Z — на весь экран · Esc — снять выбор': 'Wheel — zoom · right click / Space + mouse — move · F — fit · Z — full screen · Esc — clear selection',
  'Потяни, чтобы изменить высоту окна (двойной клик — вернуть)': 'Drag to change the window height (double-click to reset)',
  // карта: виды блоков
  "name: 'Страница', short: 'страница'": "name: 'Page', short: 'page'",
  "name: 'Стиль (CSS)', short: 'стиль'": "name: 'Style (CSS)', short: 'style'",
  "name: 'Скрипт (JS)', short: 'скрипт'": "name: 'Script (JS)', short: 'script'",
  "name: 'Серверный файл', short: 'сервер'": "name: 'Server file', short: 'server'",
  "name: 'Таблица базы данных', short: 'таблица'": "name: 'Database table', short: 'table'",
  "name: 'Внешний сервис', short: 'сервис'": "name: 'External service', short: 'service'",
  "t: '1. Страницы', s: 'что открывает пользователь'": "t: '1. Pages', s: 'what the user opens'",
  "t: '2. Оформление и скрипты', s: 'как выглядит и что делает'": "t: '2. Styles and scripts', s: 'how it looks and what it does'",
  "t: '3. Сервер', s: 'принимает запросы и отвечает'": "t: '3. Server', s: 'receives requests and answers'",
  "t: '4. Данные', s: 'база и внешние сервисы'": "t: '4. Data', s: 'database and external services'",
  "['page', 'Страница', 'то, что браузер открывает по адресу (HTML)']": "['page', 'Page', 'what the browser opens at an address (HTML)']",
  "['style', 'Стиль', 'как всё выглядит: цвета, шрифты, отступы (CSS)']": "['style', 'Style', 'how everything looks: colors, fonts, spacing (CSS)']",
  "['script', 'Скрипт', 'что происходит в браузере по клику (JS)']": "['script', 'Script', 'what happens in the browser on click (JS)']",
  "['server', 'Сервер', 'принимает запросы от сайта и отвечает']": "['server', 'Server', 'receives requests from the site and answers']",
  "['table', 'Таблица', 'где в базе хранятся данные']": "['table', 'Table', 'where the database stores data']",
  "['external', 'Внешний сервис', 'чужая служба в интернете (Telegram, почта…)']": "['external', 'External service', 'someone else\\'s service on the internet (Telegram, mail…)']",
  "style: 'Оформление (CSS)', script: 'Скрипты (JS)', table: 'Таблицы базы данных', external: 'Внешние сервисы'": "style: 'Styles (CSS)', script: 'Scripts (JS)', table: 'Database tables', external: 'External services'",
  // карта: подписи
  '>Свернуть<': '>Collapse<',
  "'Свернуть' : 'На весь экран'": "'Collapse' : 'Full screen'",
  '<h2>Что здесь есть</h2>': '<h2>What is here</h2>',
  'Страниц: ': 'Pages: ',
  ', стилей: ': ', styles: ',
  ', скриптов: ': ', scripts: ',
  '. Серверных файлов: ': '. Server files: ',
  ' (адресов, которые они обслуживают: ': ' (addresses they serve: ',
  '). Таблиц БД: ': '). Database tables: ',
  ', внешних сервисов: ': ', external services: ',
  'Нажми на любой блок: я покажу всю цепочку и объясню, что это.': 'Click any block: I will show the whole chain and explain what it is.',
  'Линии: сплошные — прямая связь, пунктир — страница подключает скрипт не напрямую, а через import. Число на карточке — сколько адресов (на сервере) или запросов (в скрипте); у таблиц и сервисов «×3» значит, что с ними работают три файла.':
    'Lines: solid — a direct link, dashed — the page includes the script not directly but through import. The number on a card is how many addresses (on the server) or requests (in a script); for tables and services «×3» means three files work with them.',
  "'Связано'": "'Related'",
  ' запр.': ' req.',
  "'через import' : 'напрямую'": "'via import' : 'directly'",
  'Дальше по цепочке →': 'Next in the chain →',
  '← Откуда приходят': '← Where they come from',
  'Открыть файл': 'Open file',
  'Показывать пока нечего. Карта строится по HTML-страницам и серверу на Express: добавь в проект страницу с подключёнными стилями и скриптами.':
    'Nothing to show yet. The map is built from HTML pages and an Express server: add a page with linked styles and scripts to the project.',
  "'Страниц ' + s.pages + ' · стилей '": "'Pages ' + s.pages + ' · styles '",
  ' · скриптов ': ' · scripts ',
  ' · серверных файлов ': ' · server files ',
  ' · таблиц ': ' · tables ',
  ' · внешних сервисов ': ' · external services ',
  'Не получилось построить карту: ': 'Could not build the map: ',
};

const KEYS = Object.keys(WEB).sort((a, b) => b.length - a.length);

export function localizeHtml(html: string): string {
  if (getLang() === 'ru') return html;
  let out = html;
  for (const k of KEYS) if (out.includes(k)) out = out.split(k).join(WEB[k]);
  return out;
}

export const WEB_KEYS = KEYS;
