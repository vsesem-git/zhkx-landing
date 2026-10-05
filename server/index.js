/* ============================================================================
 *  server/index.js — ВЕБ-СЕРВЕР ЖКУ · КРЫМ
 *  ---------------------------------------------------------------------------
 *  Один процесс Node.js без внешних зависимостей делает всё:
 *    • раздаёт статику приложения (index.html, assets/, PWA-файлы);
 *    • хранит пользовательские данные в data/state.js и ведёт историю ревизий;
 *    • принимает операции синхронизации (POST /api/events);
 *    • считает и отправляет напоминания (Telegram, опционально).
 *
 *  Запуск:
 *      node server/index.js                     # порт 8000
 *      PORT=8080 node server/index.js
 *      ZHKX_TOKEN=мой-секрет node server/index.js
 *      ZHKX_DEMO_AUTH=1 node server/index.js    # песочница: токен «demo-token»
 *
 *  Безопасность: по умолчанию сервер не раздаёт файлы data/ и server/ —
 *  наружу отдаются только index.html, manifest.webmanifest, sw.js и assets/**.
 * ==========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const api = require('./api');
const store = require('./store');
const auth = require('./auth');
const configLoader = require('./config-loader');
const notify = require('./notify');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

/* --------------------------------------------------------- статика (whitelist) */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/* Белый список файлов: всё остальное (data/, server/, tools/, package.json) наружу не отдаётся */
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/sw.js', 'sw.js'],
  ['/offline.js', 'offline.js'],
  ['/favicon.svg', 'favicon.svg']
]);
const ASSETS_ROOT = path.join(ROOT, 'assets');

/**
 * Превращает путь запроса в путь на диске — или возвращает null.
 * Путь декодируется и нормализуется ДО проверок, поэтому «/assets/../data/state.js»
 * и «/assets/..%2fdata%2fstate.js» не могут обойти белый список.
 */
function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  if (decoded.indexOf('\0') !== -1 || decoded.indexOf('\\') !== -1) return null;
  const normalized = path.posix.normalize(decoded);
  if (PUBLIC_FILES.has(normalized)) return path.join(ROOT, PUBLIC_FILES.get(normalized));
  if (normalized.startsWith('/assets/')) {
    const full = path.resolve(ROOT, normalized.replace(/^\/+/, ''));
    if (full === ASSETS_ROOT || full.startsWith(ASSETS_ROOT + path.sep)) return full;
  }
  return null;
}

function serveStatic(req, res, pathname) {
  const full = resolveStatic(pathname);
  if (!full) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено (по этому пути файлы не раздаются)');
  }
  const rel = path.relative(ROOT, full);

  fs.stat(full, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Файл не найден: ' + rel);
    }
    const ext = path.extname(full).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff'
    };
    /* Service worker должен управлять всем сайтом */
    if (rel === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  });
}

/* ------------------------------ state.js по прямому адресу (для script src) --- */
function serveStateJs(req, res, url) {
  const token = url.searchParams.get('token');
  if (!auth.checkToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return res.end('/* Требуется токен: /data/state.js?token=… */');
  }
  try {
    const text = fs.readFileSync(store.STATE_FILE, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(text);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end('/* Ошибка чтения data/state.js: ' + e.message + ' */');
  }
}

/* ------------------------------------------------------------------- сервер */
const server = http.createServer(function (req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    res.writeHead(400); return res.end('Некорректный запрос');
  }
  let pathname;
  try {
    pathname = path.posix.normalize(decodeURIComponent(url.pathname));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Некорректный путь');
  }

  /* CORS не нужен: приложение отдаётся этим же сервером.
     Но если кто-то откроет файл локально (file://), разрешим запросы с любого источника,
     поскольку доступ всё равно защищён токеном. */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname === '/data/state.js') return serveStateJs(req, res, url);

  if (pathname.startsWith('/api/')) {
    Promise.resolve()
      .then(function () { return api.handle(req, res, url); })
      .catch(function (e) {
        console.error('[api] ошибка:', e);
        if (!res.headersSent) {
          res.writeHead(e.code === 'BROKEN_STATE' ? 500 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }

  serveStatic(req, res, pathname);
});

/* -------------------------------------------------------------------- запуск */
function boot() {
  store.ensureDirs();
  const { data } = store.load();
  const a = auth.loadOrCreate();
  const config = configLoader.status();

  server.listen(PORT, HOST, function () {
    const banner = [
      '',
      '  🏠  ЖКУ · Крым — сервер учёта коммунальных услуг',
      '  ─────────────────────────────────────────────────────────',
      '  Приложение      : http://localhost:' + PORT + '/',
      '  Хранилище       : data/state.js (ревизия ' + data.meta.revision + ', записей ' + data.journal.length + ')',
      '  История ревизий : data/history/ (лимит ' + (process.env.ZHKX_HISTORY_LIMIT || 60) + ')',
      '  Справочники     : ' + config.objects + ' объектов · ' + config.archiveRecords + ' записей архивов водомеров',
      '  Токен доступа   : ' + (a.demoAuth ? 'демо-режим песочницы → "demo-token"' : (a.source === 'env' ? 'взят из ZHKX_TOKEN' : (a.source === 'file' ? 'из data/auth.json' : 'создан: ' + a.token))),
      '  Telegram        : ' + (notify.isConfigured() ? 'включён' : 'выключен (ZHKX_TELEGRAM_TOKEN / ZHKX_TELEGRAM_CHAT)'),
      '  ─────────────────────────────────────────────────────────',
      ''
    ].join('\n');
    console.log(banner);
  });
}

if (require.main === module) {
  boot();
  notify.startScheduler({ runOnStart: false });
}

module.exports = { server, boot, PORT };
