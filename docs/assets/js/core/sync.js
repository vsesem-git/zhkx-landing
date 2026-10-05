/* ============================================================================
 *  CORE / SYNC — СИНХРОНИЗАЦИЯ С СЕРВЕРОМ (данные в data/state.js)
 *  ---------------------------------------------------------------------------
 *  Приложение работает офлайн-first: все действия мгновенно попадают в
 *  локальное состояние и в очередь операций, а сервер получает их пачкой.
 *
 *  Режимы работы:
 *    • «Сервер»    — приложение открыто с того же адреса, что и API;
 *    • «Локально»  — сервера нет (открыт файл или статический хостинг):
 *                    работает точно как раньше, только на localStorage;
 *    • «Офлайн»    — сервер недоступен: изменения копятся в очереди и уходят,
 *                    как только связь появится.
 *
 *  Что делает модуль:
 *    pull()   — забирает состояние с сервера и накладывает неотправленные правки;
 *    flush()  — отправляет очередь операций (идемпотентно, без дублей);
 *    start()  — автосинхронизация: после изменений, раз в минуту, при появлении
 *               сети и при возврате к вкладке;
 *    login()  — вход по токену доступа;
 *    history()/restore() — список ревизий data/state.js и откат к версии;
 *    reminders() — что сервер отправит в Telegram.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var State = global.ZHKX.State;
  var U = global.ZHKX.Utils;
  var Data = global.ZHKX.Data;

  var CFG_KEY = 'zhkx.server.v1';
  var API_BASE = '';                 // пусто = тот же адрес, что и приложение
  var FLUSH_DEBOUNCE = 1500;
  var POLL_INTERVAL = 60000;

  /* Серверный режим возможен только там, где есть fetch и http(s)-адрес:
     при открытии файла с диска (file://) приложение работает локально. */
  var supported = !!(global.fetch && (global.location.protocol === 'http:' || global.location.protocol === 'https:'));

  var cfg = {
    url: '',
    token: '',
    clientId: '',
    autoSync: true,
    lastRevision: 0,
    lastSyncAt: null,
    lastError: null
  };

  var status = {
    code: 'init',            // init | local | offline | unauthorized | syncing | synced | pending | error | disabled
    label: 'Проверка сервера…',
    detail: '',
    pending: 0,
    revision: 0,
    serverTime: null,
    lastSyncAt: null,
    health: null,
    error: null
  };

  var listeners = [];
  var timers = { flush: null, poll: null };
  var started = false;

  /* ------------------------------------------------------------- хранилище */
  function loadCfg() {
    try {
      var raw = global.localStorage.getItem(CFG_KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) { /* игнорируем */ }
    if (!cfg.clientId) {
      cfg.clientId = 'dev-' + Math.random().toString(36).slice(2, 10);
      saveCfg();
    }
    return cfg;
  }

  function saveCfg() {
    try { global.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* игнорируем */ }
  }

  function onStatusChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function setStatus(code, patch) {
    Object.assign(status, patch || {});
    status.code = code;
    status.pending = State.pendingCount();
    status.revision = State.revision();
    status.lastSyncAt = cfg.lastSyncAt;
    var labels = {
      init: 'Проверка сервера…',
      local: 'Локальный режим',
      offline: 'Офлайн — данные у себя',
      unauthorized: 'Требуется вход',
      syncing: 'Синхронизация…',
      synced: 'Синхронизировано',
      pending: 'Есть неотправленные изменения',
      error: 'Ошибка синхронизации',
      disabled: 'Синхронизация выключена'
    };
    status.label = labels[code] || code;
    listeners.forEach(function (fn) {
      try { fn(status); } catch (e) { console.error(e); }
    });
    return status;
  }

  function info() {
    return {
      supported: supported,
      url: cfg.url || global.location.origin,
      sameOrigin: !cfg.url,
      token: !!cfg.token,
      autoSync: cfg.autoSync,
      clientId: cfg.clientId,
      status: status.code,
      label: status.label,
      detail: status.detail,
      pending: status.pending,
      revision: status.revision,
      lastSyncAt: status.lastSyncAt,
      lastError: status.lastError,
      health: status.health,
      token_required: status.code === 'unauthorized',
      demoAuth: !!(status.health && status.health.auth && status.health.auth.demoAuth)
    };
  }

  /* ------------------------------------------------------------------ HTTP */
  function api(path, options) {
    var o = options || {};
    var url = (cfg.url || '') + path;
    var headers = Object.assign({ 'Accept': 'application/json' }, o.headers || {});
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;

    return global.fetch(url, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      cache: 'no-store',
      credentials: 'omit'
    }).then(function (res) {
      var contentType = res.headers.get('content-type') || '';
      if (contentType.indexOf('json') === -1) {
        return res.text().then(function (text) {
          throw Object.assign(new Error('Сервер вернул не JSON (HTTP ' + res.status + ')'), { status: res.status, body: text.slice(0, 200) });
        });
      }
      return res.json().then(function (json) {
        if (!res.ok || json.ok === false) {
          throw Object.assign(new Error(json.error || ('HTTP ' + res.status)), { status: res.status, json: json });
        }
        return json;
      });
    });
  }

  /* -------------------------------------------------------------- проверка */
  function health() {
    return api('/api/health').then(function (json) {
      status.health = json;
      cfg.lastRevision = json.revision || 0;
      saveCfg();
      return json;
    });
  }

  /* ------------------------------------------------------------------- pull */
  function pull(options) {
    var o = options || {};
    if (!cfg.token) return Promise.reject(Object.assign(new Error('Нет токена доступа'), { status: 401 }));
    return api('/api/state').then(function (json) {
      State.applyServerState(json.state, { keepPending: o.keepPending !== false });
      State.setRevision(json.revision, json.updatedAt);
      cfg.lastRevision = json.revision;
      cfg.lastSyncAt = new Date().toISOString();
      cfg.lastError = null;
      saveCfg();
      setStatus('synced', { detail: 'Ревизия ' + json.revision });
      return json;
    });
  }

  /* ------------------------------------------------------------------ flush */
  function flush(options) {
    var o = options || {};
    /* Локальный режим: отправлять некуда, изменения хранит localStorage */
    if (!supported) return Promise.resolve({ ok: true, sent: 0, local: true });
    var ops = State.pendingOps();
    if (!ops.length) {
      /* Отправлять нечего: обновимся, если сервер ушёл вперёд */
      if (o.force) return pull();
      return Promise.resolve({ ok: true, sent: 0 });
    }
    if (!cfg.token) {
      setStatus('unauthorized', { detail: 'Очередь: ' + ops.length });
      return Promise.reject(Object.assign(new Error('Требуется токен доступа'), { status: 401 }));
    }

    setStatus('syncing', { detail: 'Отправка ' + ops.length + ' ' + U.plural(ops.length, 'операции', 'операций', 'операций') });

    return api('/api/events', {
      method: 'POST',
      body: { ops: ops, baseRevision: State.revision(), clientId: cfg.clientId }
    }).then(function (json) {
      State.clearOps(ops.map(function (op) { return op.id; }));
      State.applyServerState(json.state, { keepPending: true });
      State.setRevision(json.revision, json.updatedAt);
      cfg.lastRevision = json.revision;
      cfg.lastSyncAt = new Date().toISOString();
      cfg.lastError = null;
      saveCfg();
      setStatus('synced', { detail: 'Ревизия ' + json.revision });
      return { ok: true, sent: ops.length, applied: json.applied.length, skipped: json.skipped.length, conflict: json.conflict, revision: json.revision };
    }).catch(function (err) {
      cfg.lastError = err.message;
      saveCfg();
      if (err.status === 401) { setStatus('unauthorized', { detail: err.message, error: err.message }); throw err; }
      if (err.status === 429) { setStatus('error', { detail: err.message, error: err.message }); throw err; }
      /* Сеть недоступна — остаёмся офлайн, операции не теряются */
      if (!global.navigator || global.navigator.onLine !== false) {
        setStatus('offline', { detail: err.message, error: err.message });
      } else {
        setStatus('offline', { detail: 'Нет подключения к сети' });
      }
      throw err;
    });
  }

  /** Полная отправка локального состояния (используется при импорте/демо/сбросе) */
  function pushFullState(reason) {
    if (!supported) return Promise.reject(new Error('Сервер не настроен: приложение работает локально'));
    if (!cfg.token) return Promise.reject(Object.assign(new Error('Требуется токен доступа'), { status: 401 }));
    var state = State.snapshotForServer();
    return api('/api/import', {
      method: 'POST',
      body: { state: state, clientId: cfg.clientId, reason: reason || 'full-push' }
    }).then(function (json) {
      State.clearOps();
      cfg.lastSyncAt = new Date().toISOString();
      saveCfg();
      return pull();
    });
  }

  /* --------------------------------------------------------------- вход/выход */
  function login(token) {
    var clean = String(token || '').trim();
    if (!clean) return Promise.reject(new Error('Введите токен доступа'));
    return api('/api/login', { method: 'POST', body: { token: clean } }).then(function () {
      cfg.token = clean;
      cfg.lastError = null;
      saveCfg();
      return health().then(function () { return pull(); });
    });
  }

  function logout() {
    cfg.token = '';
    saveCfg();
    setStatus('local', { detail: 'Токен удалён — данные только на этом устройстве' });
  }

  function setAutoSync(on) {
    cfg.autoSync = !!on;
    saveCfg();
    if (cfg.autoSync) scheduleFlush();
    setStatus(State.pendingCount() ? 'pending' : 'synced');
    return cfg.autoSync;
  }

  function setServerUrl(url) {
    cfg.url = String(url || '').replace(/\/+$/, '');
    saveCfg();
    return connect();
  }

  /* ------------------------------------------------------------- автосинхрон */
  function scheduleFlush() {
    if (!cfg.autoSync) return;
    clearTimeout(timers.flush);
    timers.flush = setTimeout(function () {
      flush().catch(function () { /* статус уже обновлён */ });
    }, FLUSH_DEBOUNCE);
  }

  function startPolling() {
    clearInterval(timers.poll);
    timers.poll = setInterval(function () {
      if (!cfg.autoSync) return;
      if (State.pendingCount()) return scheduleFlush();
      pull().catch(function (e) {
        if (e.status !== 401) setStatus('offline', { detail: e.message });
      });
    }, POLL_INTERVAL);
  }

  function start() {
    if (started) return Promise.resolve(info());
    started = true;
    loadCfg();

    if (!supported) {
      setStatus('local', { detail: 'Сервер не настроен — данные хранятся в этом браузере' });
      return Promise.resolve(info());
    }

    State.onSave(function () {
      if (!cfg.autoSync) return;
      if (State.pendingCount()) {
        setStatus('pending', { detail: 'Очередь: ' + State.pendingCount() });
        scheduleFlush();
      }
    });

    global.addEventListener('online', function () {
      setStatus('syncing', { detail: 'Связь восстановлена' });
      flush().catch(function () {});
    });
    global.addEventListener('offline', function () {
      setStatus('offline', { detail: 'Нет подключения к сети' });
    });
    global.document.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState !== 'visible' || !cfg.autoSync) return;
      if (State.pendingCount()) flush().catch(function () {});
      else pull().catch(function () {});
    });

    startPolling();
    return connect();
  }

  /** Подключение: проверяем сервер, при наличии токена забираем данные */
  function connect() {
    if (!supported) return Promise.resolve(setStatus('local', {
      detail: global.location.protocol === 'file:'
        ? 'Приложение открыто с диска (file://) — сервер недоступен, работаем локально'
        : 'Браузер не поддерживает fetch — работаем локально'
    }));
    setStatus('init');
    return health().then(function (json) {
      if (!cfg.token) {
        setStatus('unauthorized', { detail: 'Введите токен доступа, чтобы включить синхронизацию' });
        return info();
      }
      return pull().then(function () {
        if (State.pendingCount()) return flush();
        return info();
      }).catch(function (err) {
        if (err.status === 401) setStatus('unauthorized', { detail: 'Неверный или устаревший токен' });
        else setStatus('offline', { detail: err.message });
        return info();
      });
    }).catch(function (err) {
      /* Сервера нет вовсе: приложение продолжает работать локально */
      status.health = null;
      return setStatus('local', { detail: 'Сервер не обнаружен — данные хранятся только в этом браузере' });
    });
  }

  /* --------------------------------------------------------- серверные данные */
  function history(limit) {
    return api('/api/revisions' + (limit ? '?limit=' + limit : ''));
  }

  function restore(file) {
    return api('/api/restore', { method: 'POST', body: { file: file, clientId: cfg.clientId } })
      .then(function (json) {
        State.applyServerState(json.state, { keepPending: false });
        State.setRevision(json.revision, null);
        return json;
      });
  }

  function reminders() { return api('/api/reminders'); }

  function sendReminders() { return api('/api/reminders/send', { method: 'POST', body: {} }); }

  function serverConfig() { return api('/api/config'); }

  function isSupported() { return supported; }

  function downloadServerState() {
    var url = (cfg.url || '') + '/data/state.js?token=' + encodeURIComponent(cfg.token);
    return url;
  }

  var Sync = {
    CFG_KEY: CFG_KEY,
    start: start,
    connect: connect,
    health: health,
    pull: pull,
    flush: flush,
    pushFullState: pushFullState,
    login: login,
    logout: logout,
    setAutoSync: setAutoSync,
    setServerUrl: setServerUrl,
    scheduleFlush: scheduleFlush,
    info: info,
    onStatusChange: onStatusChange,
    config: function () { return cfg; },
    history: history,
    restore: restore,
    reminders: reminders,
    sendReminders: sendReminders,
    serverConfig: serverConfig,
    downloadServerState: downloadServerState,
    isSupported: isSupported
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.Sync = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
