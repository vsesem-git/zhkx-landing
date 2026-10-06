/* ============================================================================
 *  CORE / SYNC — СИНХРОНИЗАЦИЯ С СЕРВЕРОМ (данные в data/state.js)
 *  ---------------------------------------------------------------------------
 *  Приложение работает офлайн-first: все действия мгновенно попадают в
 *  локальное состояние и в очередь операций, а сервер получает их пачкой.
 *
 *  Поддерживаются два серверных движка (клиент определяет их сам):
 *    • PHP на обычном хостинге — api.php рядом с index.html, данные пишутся
 *      в zhkx-data/state.js. Достаточно залить папку и открыть её в браузере;
 *    • Node.js — server/index.js, данные в data/state.js.
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

  /* Каким движком отвечает сервер и по какому адресу к нему обращаться.
     apiKind: 'php' (api.php на хостинге) | 'node' (server/index.js) | null (не найден) */
  var apiKind = null;
  var apiBase = '/';

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
      url: resolvedUrl(),
      sameOrigin: !cfg.url,
      apiKind: apiKind,
      apiKindLabel: apiKind === 'php' ? 'PHP на хостинге' : (apiKind === 'node' ? 'Node.js' : '—'),
      open: openMode(),
      exposed: status.health ? status.health.dataDirExposed : undefined,
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

  /* ------------------------------------------------------- адрес и определение */

  /** Каталог, в котором открыто приложение (для относительных запросов) */
  function documentDir() {
    var href = (global.document && global.document.baseURI) || global.location.href;
    return href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  }

  function joinUrl(base, path) {
    return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  /** Человекочитаемый адрес сервера */
  function resolvedUrl() {
    if (!apiKind) return cfg.url || global.location.origin;
    try {
      return (new URL(apiBase, global.location.href).href.replace(/\/+$/, '')) || global.location.origin;
    } catch (e) {
      return apiBase;
    }
  }

  /** Режим «сервер не требует токена» (PHP-версия до «Закрыть паролем») */
  function openMode() {
    var auth = status.health && status.health.auth;
    return !!(auth && (auth.open === true || auth.authRequired === false));
  }

  function canCall() { return !!cfg.token || openMode(); }

  /**
   * Ссылка на конкретный маршрут API с учётом движка сервера.
   * PHP:  api.php?route=state   ·   Node:  /api/state
   */
  function endpoint(path, params) {
    var query = '';
    if (params) {
      Object.keys(params).forEach(function (key) {
        var value = params[key];
        if (value === undefined || value === null || value === '') return;
        query += (query ? '&' : '') + encodeURIComponent(key) + '=' + encodeURIComponent(value);
      });
    }

    if (apiKind === 'php') {
      var phpUrl = joinUrl(apiBase, 'api.php') + '?route=' + encodeURIComponent(path);
      return query ? phpUrl + '&' + query : phpUrl;
    }

    var nodeUrl = joinUrl(apiBase, path === 'state-file' ? 'data/state.js' : 'api/' + path);
    return query ? nodeUrl + '?' + query : nodeUrl;
  }

  /** Проверка одного кандидата: отвечает ли по этому адресу наш сервер */
  function probe(candidate) {
    var controller = typeof global.AbortController !== 'undefined' ? new global.AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 6000);
    return global.fetch(candidate.url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      clearTimeout(timer);
      if (json && json.ok === true && json.app && json.app.id === 'zhkx-crimea') {
        return { candidate: candidate, health: json };
      }
      return null;
    }).catch(function () {
      clearTimeout(timer);
      return null;
    });
  }

  /** Поиск сервера: сначала PHP рядом со страницей, затем Node */
  function discover() {
    if (!supported) return Promise.resolve(null);
    var dir = cfg.url
      ? (/^https?:/i.test(cfg.url) ? cfg.url.replace(/\/+$/, '') + '/' : joinUrl(documentDir(), cfg.url))
      : documentDir();

    var list = [{ kind: 'php', url: joinUrl(dir, 'api.php') + '?route=health', base: dir }];
    if (!cfg.url) {
      list.push({ kind: 'php', url: '/api.php?route=health', base: '/' });
      list.push({ kind: 'node', url: joinUrl(dir, 'api/health'), base: dir });
      list.push({ kind: 'node', url: '/api/health', base: '/' });
    } else {
      list.push({ kind: 'node', url: joinUrl(dir, 'api/health'), base: dir });
    }

    var attempt = function (index) {
      if (index >= list.length) return Promise.resolve(null);
      return probe(list[index]).then(function (found) {
        if (found) {
          apiKind = found.candidate.kind;
          apiBase = found.candidate.base;
          status.health = found.health;
          return found.health;
        }
        return attempt(index + 1);
      });
    };
    return attempt(0);
  }

  /* ------------------------------------------------------------------ HTTP */
  function api(path, options) {
    var o = options || {};
    var url = endpoint(path, o.params);
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
    return api('health').then(function (json) {
      status.health = json;
      cfg.lastRevision = json.revision || 0;
      saveCfg();
      verifyExposure();
      return json;
    });
  }

  /**
   * Проверяем сами (из браузера), не отдаётся ли файл состояния по прямой ссылке.
   * Серверная самопроверка может быть недоступна (запрет исходящих запросов,
   * однопоточный сервер) — тогда решает этот запрос: если файл читается и в нём
   * виден маркер состояния, каталог данных открыт наружу.
   */
  function verifyExposure() {
    if (!apiKind || !supported) return;
    var url = apiKind === 'php'
      ? joinUrl(apiBase, 'zhkx-data/state.js')
      : joinUrl(apiBase, 'data/state.js');
    global.fetch(url, { cache: 'no-store', credentials: 'omit' }).then(function (res) {
      if (!res.ok && res.status !== 0) return '';   // закрыто — и хорошо
      return res.text();
    }).then(function (text) {
      var exposed = /ZHKX\.StateData/.test(text || '');
      if (!status.health) return;
      if (status.health.dataDirExposed === exposed) return;
      status.health.dataDirExposed = exposed;
      status.health.dataDirExposedBy = 'browser';
      listeners.forEach(function (fn) { try { fn(status); } catch (e) { /* ignore */ } });
    }).catch(function () { /* нет сети или запрещено — оставляем как есть */ });
  }

  /* ------------------------------------------------------------------- pull */
  function pull(options) {
    var o = options || {};
    if (!canCall()) return Promise.reject(Object.assign(new Error('Нет токена доступа'), { status: 401 }));
    return api('state').then(function (json) {
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
    if (!canCall()) {
      setStatus('unauthorized', { detail: 'Очередь: ' + ops.length });
      return Promise.reject(Object.assign(new Error('Требуется токен доступа'), { status: 401 }));
    }

    setStatus('syncing', { detail: 'Отправка ' + ops.length + ' ' + U.plural(ops.length, 'операции', 'операций', 'операций') });

    return api('events', {
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
    if (!canCall()) return Promise.reject(Object.assign(new Error('Требуется токен доступа'), { status: 401 }));
    var state = State.snapshotForServer();
    return api('import', {
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
    return api('login', { method: 'POST', body: { token: clean } }).then(function () {
      cfg.token = clean;
      cfg.lastError = null;
      saveCfg();
      return health().then(function () { return pull(); });
    });
  }

  /**
   * «Закрыть паролем»: PHP-версия по умолчанию открыта — здесь генерируем токен
   * и сразу запоминаем его в этом браузере.
   */
  function lock(token) {
    return api('lock', { method: 'POST', body: { token: String(token || '').trim() } }).then(function (json) {
      if (json && json.token) {
        cfg.token = json.token;
        cfg.lastError = null;
        saveCfg();
      }
      return health().then(function () {
        if (cfg.token) return pull();
        return null;
      }).then(function () { return json; });
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
    apiKind = null;
    apiBase = '/';
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

  /** Подключение: ищем сервер; в открытом режиме работаем сразу, иначе нужен токен */
  function connect() {
    if (!supported) return Promise.resolve(setStatus('local', {
      detail: global.location.protocol === 'file:'
        ? 'Приложение открыто с диска (file://) — сервер недоступен, работаем локально'
        : 'Браузер не поддерживает fetch — работаем локально'
    }));
    setStatus('init');
    return discover().then(function (json) {
      if (!json) {
        /* Сервера нет вовсе (статический хостинг): приложение работает локально */
        apiKind = null;
        apiBase = '/';
        status.health = null;
        return setStatus('local', {
          detail: 'Сервер не обнаружен — данные хранятся только в этом браузере. Залейте папку с api.php или запустите server/index.js.'
        });
      }

      status.health = json;
      verifyExposure();
      if (!canCall()) {
        setStatus('unauthorized', {
          detail: (json.auth && json.auth.demoAuth)
            ? 'Демо-режим сервера: вход выполняется автоматически'
            : 'Введите токен доступа, чтобы включить синхронизацию'
        });
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
    });
  }

  /* --------------------------------------------------------- серверные данные */
  function history(limit) {
    return api('revisions', limit ? { limit: limit } : null);
  }

  function restore(file) {
    return api('restore', { method: 'POST', body: { file: file, clientId: cfg.clientId } })
      .then(function (json) {
        State.applyServerState(json.state, { keepPending: false });
        State.setRevision(json.revision, null);
        return json;
      });
  }

  function reminders() { return api('reminders'); }

  function sendReminders() { return api('reminders/send', { method: 'POST', body: {} }); }

  function serverConfig() { return api('config'); }

  function isSupported() { return supported; }

  /** Ссылка на скачивание файла состояния с сервера (с токеном в адресе) */
  function downloadServerState() {
    if (apiKind === 'php') return endpoint('state-file', { token: cfg.token });
    return joinUrl(apiBase, 'data/state.js') + '?token=' + encodeURIComponent(cfg.token || '');
  }

  /** Ссылка на страницу проверки сервера (её показывает PHP-версия) */
  function serverCheckUrl() {
    if (apiKind === 'php') return joinUrl(apiBase, 'api.php');
    return null;
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
    lock: lock,
    endpoint: endpoint,
    discover: discover,
    serverCheckUrl: serverCheckUrl,
    history: history,
    restore: restore,
    reminders: reminders,
    sendReminders: sendReminders,
    serverConfig: serverConfig,
    verifyExposure: verifyExposure,
    downloadServerState: downloadServerState,
    isSupported: isSupported
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.Sync = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
