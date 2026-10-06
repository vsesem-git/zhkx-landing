/* ============================================================================
 *  server/api.js — REST API ПРИЛОЖЕНИЯ
 *  ---------------------------------------------------------------------------
 *  GET    /api/health              публично: состояние сервера, нужен ли токен
 *  POST   /api/login               проверка токена (для экрана входа)
 *  GET    /api/state               всё состояние пользователя + revision (ETag)
 *  POST   /api/events              приём пачки операций клиента (идемпотентно)
 *  GET    /api/config              справочники из config.js (объекты, тарифы, ПУ)
 *  GET    /api/config/status       что загружено и когда менялся файл
 *  GET    /api/reminders           что сервер отправит в Telegram сейчас
 *  POST   /api/reminders/send      отправить напоминания немедленно
 *  GET    /api/revisions           список ревизий data/state.js
 *  GET    /api/revisions/:file     скачать ревизию
 *  POST   /api/restore             откатиться к ревизии (создаёт новую ревизию)
 *  GET    /api/export              резервная копия JSON (с серверной обвязкой)
 *  POST   /api/import              заменить состояние из бэкапа
 *  POST   /api/reset               очистить пользовательские данные
 *  GET    /api/token  (админ)      показать текущий токен (только на localhost)
 * ==========================================================================*/
'use strict';

const store = require('./store');
const auth = require('./auth');
const configLoader = require('./config-loader');
const notify = require('./notify');

const STARTED_AT = Date.now();
const APP_VERSION = '2.0.0';

/* ------------------------------------------------------------------ хелперы */
function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    const limit = limitBytes || 32 * 1024 * 1024;
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve(null);
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(new Error('Некорректный JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function localRequest(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/* --------------------------------------------------------------- маршрутизация */
async function handle(req, res, url) {
  const pathName = url.pathname;
  const method = req.method.toUpperCase();

  /* ---------- публичные ---------- */
  if (pathName === '/api/health') {
    let revision = null, updatedAt = null, error = null, checksum = null, size = null;
    try {
      const loaded = store.load();
      revision = loaded.data.meta.revision;
      updatedAt = loaded.data.meta.updatedAt;
      checksum = loaded.checksum || store.checksum(loaded.data);
      try { size = require('fs').statSync(loaded.file).size; } catch (e) { size = null; }
    } catch (e) { error = e.message; }
    return sendJson(res, 200, {
      ok: !error,
      error,
      app: { id: 'zhkx-crimea', version: APP_VERSION, storage: 'server-js', stateFile: 'data/state.js' },
      /* Идентификатор процесса: полезен, когда на одном порту случайно оказался
         другой сервер (например, остался от прошлого запуска). */
      instance: process.env.ZHKX_INSTANCE_ID || null,
      dataDir: store.DATA_DIR,
      server: {
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        time: new Date().toISOString(),
        node: process.version,
        historyLimit: Number(process.env.ZHKX_HISTORY_LIMIT || 60)
      },
      revision,
      updatedAt,
      checksum,
      size,
      auth: auth.info(),
      notifications: { telegram: notify.isConfigured() },
      config: safe(function () { return configLoader.status(); })
    });
  }

  if (pathName === '/api/login' && method === 'POST') {
    const body = await readBody(req, 4096);
    const fake = { headers: { authorization: 'Bearer ' + ((body && body.token) || '') }, socket: req.socket, url: '/api/login' };
    const result = auth.check(fake);
    if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
    return sendJson(res, 200, { ok: true, message: 'Доступ разрешён' });
  }

  /* ---------- только на localhost: показать токен (удобно при настройке) ---------- */
  if (pathName === '/api/token') {
    if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'Токен доступен только с localhost' });
    const a = auth.loadOrCreate();
    return sendJson(res, 200, { ok: true, token: a.token, demoAuth: !!a.demoAuth, source: a.source, authFile: 'data/auth.json' });
  }

  /* ---------- всё остальное требует токен ---------- */
  const authResult = auth.check(req);
  if (!authResult.ok) {
    return sendJson(res, authResult.status, Object.assign({ ok: false, error: authResult.error }, authResult.remainingAttempts !== undefined ? { remainingAttempts: authResult.remainingAttempts } : {}));
  }

  if (pathName === '/api/state' && method === 'GET') {
    const { data } = store.load();
    const etag = '"rev-' + data.meta.revision + '-' + store.checksum(data).slice(7, 19) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    return sendJson(res, 200, {
      ok: true,
      revision: data.meta.revision,
      updatedAt: data.meta.updatedAt,
      checksum: store.checksum(data),
      state: store.normalize(JSON.parse(JSON.stringify(data)))
    }, { ETag: etag });
  }

  if (pathName === '/api/events' && method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.ops)) return sendJson(res, 400, { ok: false, error: 'Ожидается { ops: [...] }' });
    return store.withLock(function () {
      const { data } = store.load();
      const base = Number(body.baseRevision || 0);
      const conflict = base > 0 && base !== data.meta.revision;
      const result = store.applyOps(data, body.ops);
      const saved = result.changed
        ? store.persist(result.data, { reason: 'events', actor: body.clientId || 'client' })
        : { data, revision: data.meta.revision, updatedAt: data.meta.updatedAt, historyFile: null, checksum: store.checksum(data) };
      return sendJson(res, 200, {
        ok: true,
        revision: saved.revision,
        updatedAt: saved.updatedAt,
        checksum: saved.checksum,
        applied: result.applied,
        skipped: result.skipped,
        conflict: conflict ? { serverRevision: data.meta.revision, clientRevision: base } : null,
        historyFile: saved.historyFile || null,
        state: store.normalize(JSON.parse(JSON.stringify(saved.data)))
      });
    });
  }

  if (pathName === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      status: configLoader.status(),
      objects: configLoader.objects(),
      tariffs: configLoader.tariffs(),
      meters: configLoader.meters(),
      validation: configLoader.validate()
    });
  }

  if (pathName === '/api/config/status' && method === 'GET') {
    return sendJson(res, 200, { ok: true, config: configLoader.status() });
  }

  if (pathName === '/api/reminders' && method === 'GET') {
    const list = notify.reminders();
    return sendJson(res, 200, {
      ok: true,
      telegramConfigured: notify.isConfigured(),
      count: list.length,
      reminders: list,
      preview: notify.toTelegramText(list)
    });
  }

  if (pathName === '/api/reminders/send' && method === 'POST') {
    const result = await notify.sendNow();
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (pathName === '/api/revisions' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 50);
    return sendJson(res, 200, { ok: true, revisions: store.revisions(Math.min(limit, 200)), current: store.load().data.meta.revision });
  }

  if (pathName.startsWith('/api/revisions/') && method === 'GET') {
    const file = decodeURIComponent(pathName.replace('/api/revisions/', ''));
    try {
      const rev = store.readRevision(file);
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + rev.file + '"' });
      return res.end(rev.text);
    } catch (e) {
      return sendJson(res, 404, { ok: false, error: e.message });
    }
  }

  if (pathName === '/api/restore' && method === 'POST') {
    const body = await readBody(req, 65536);
    if (!body || !body.file) return sendJson(res, 400, { ok: false, error: 'Ожидается { file: "state-00012-….js" }' });
    return store.withLock(function () {
      const rev = store.readRevision(body.file);
      rev.data.meta.restoredFrom = rev.file;
      const saved = store.persist(rev.data, { reason: 'restore:' + rev.file, actor: body.clientId || 'client' });
      return sendJson(res, 200, { ok: true, revision: saved.revision, restoredFrom: rev.file, state: saved.data, historyFile: saved.historyFile });
    });
  }

  if (pathName === '/api/export' && method === 'GET') {
    const { data } = store.load();
    const payload = store.backupPayload(data, {
      revision: data.meta.revision,
      file: 'data/state.js',
      version: APP_VERSION,
      time: new Date().toISOString()
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="zhkx-server-backup.json"'
    });
    return res.end(JSON.stringify(payload, null, 2));
  }

  if (pathName === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'Пустой запрос' });
    const incoming = body.state || (body.payload && body.payload.state) || body;
    if (!incoming || !Array.isArray(incoming.journal)) return sendJson(res, 400, { ok: false, error: 'В файле нет состояния с журналом начислений' });
    return store.withLock(function () {
      const { data } = store.load();
      const result = store.applyOps(data, [{ id: 'import-' + Date.now(), type: 'replace-state', at: new Date().toISOString(), payload: { state: incoming } }]);
      const saved = store.persist(result.data, { reason: 'import', actor: body.clientId || 'client' });
      return sendJson(res, 200, { ok: true, revision: saved.revision, journal: saved.data.journal.length, movements: saved.data.movements.length });
    });
  }

  if (pathName === '/api/reset' && method === 'POST') {
    return store.withLock(function () {
      const fresh = store.emptyState();
      const saved = store.persist(fresh, { reason: 'reset', actor: 'admin' });
      return sendJson(res, 200, { ok: true, revision: saved.revision });
    });
  }

  return sendJson(res, 404, { ok: false, error: 'Неизвестный маршрут: ' + method + ' ' + pathName });
}

function safe(fn) {
  try { return fn(); } catch (e) { return { error: e.message }; }
}

module.exports = { handle, APP_VERSION, sendJson, readBody, STARTED_AT };
