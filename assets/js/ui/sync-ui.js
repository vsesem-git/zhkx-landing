/* ============================================================================
 *  UI / SYNC-UI — индикатор связи и панель «Сервер и синхронизация»
 *  ---------------------------------------------------------------------------
 *  Что показывает пользователю:
 *    • бейдж в шапке: синхронизировано / есть очередь / офлайн / нужен токен;
 *    • карточку в разделе «Данные»: сервер, ревизия файла data/state.js,
 *      размер и контрольная сумма, очередь изменений, история ревизий с откатом;
 *    • модальное окно: вход по токену, адрес сервера, автосинхронизация,
 *      напоминания Telegram, выгрузка файла состояния.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.ZHKX.Utils;
  var State = global.ZHKX.State;
  var Sync = global.ZHKX.Sync;
  var Forms = global.ZHKX.Forms;

  var lastHistory = null;
  var lastReminders = null;

  /** «05.10.2026, 14:32» из ISO-строки */
  function formatDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /* ------------------------------------------------------------------ бейдж */
  function badge() {
    var i = Sync.info();
    var tone = statusTone(i.status);
    var title = serverTitle(i);
    return '<button class="sync-badge sync-badge--' + tone + '" data-action="sync-modal" title="' + U.escapeHtml(title) + '">' +
      '<span class="sync-badge__dot"></span>' +
      '<span class="sync-badge__text">' + U.escapeHtml(shortLabel(i)) + '</span>' +
      (i.pending && i.status !== 'local' ? '<span class="sync-badge__pending">' + i.pending + '</span>' : '') +
    '</button>';
  }

  function statusTone(code) {
    if (code === 'synced') return 'ok';
    if (code === 'pending' || code === 'syncing' || code === 'init') return 'wait';
    if (code === 'offline' || code === 'error') return 'bad';
    if (code === 'unauthorized') return 'warn';
    return 'idle';
  }

  function shortLabel(i) {
    if (i.status === 'synced') return 'Синхронизировано · r' + i.revision;
    if (i.status === 'pending') return 'К отправке: ' + i.pending;
    if (i.status === 'syncing') return 'Синхронизация…';
    if (i.status === 'unauthorized') return i.token ? 'Нужен вход' : 'Локальный режим';
    if (i.status === 'offline') return 'Офлайн' + (i.pending ? ' · ' + i.pending : '');
    if (i.status === 'error') return 'Ошибка синхронизации';
    if (i.status === 'disabled') return 'Синхронизация выключена';
    if (i.status === 'local') return 'Без сервера';
    return 'Проверка сервера…';
  }

  function serverTitle(i) {
    if (!i.health) return 'Сервер не обнаружен: приложение работает на данных этого браузера. Нажмите, чтобы подключить сервер.';
    return 'Сервер: ' + i.url + ' · ревизия ' + i.revision + ' · ' + U.plural(i.pending, 'в очереди 1 операция', 'в очереди ' + i.pending + ' операции', 'в очереди ' + i.pending + ' операций');
  }

  /* ------------------------------------------------- карточка в «Данных» -- */
  function dataCard() {
    var i = Sync.info();
    var s = State.get();
    var deep = JSON.stringify(State.snapshotForServer());
    return '' +
    '<article class="card card--sync" id="sync-card">' +
      '<header class="card__head"><h3>' + statusIcon(i.status) + ' Сервер и синхронизация</h3>' +
        '<span class="pill pill--' + statusTone(i.status) + '">' + U.escapeHtml(i.label) + '</span></header>' +
      '<div class="sync-card__body" data-sync-slot="body">' + bodyHtml(i, s, deep) + '</div>' +
      '<footer class="card__foot">' +
        '<button class="btn btn--primary" data-action="sync-modal">⚙️ Открыть синхронизацию</button>' +
        (i.health && i.token ? '<button class="btn btn--ghost" data-action="sync-now">🔄 Синхронизировать сейчас</button>' : '') +
        (i.health && i.token ? '<a class="btn btn--ghost" href="' + U.escapeHtml(Sync.downloadServerState()) + '" download="state.js">⬇️ Скачать data/state.js с сервера</a>' : '') +
      '</footer>' +
      '<div class="muted-sm">Данные хранятся на сервере в исполняемом js-файле <code>data/state.js</code>; браузер держит локальную копию для офлайн-работы, ' +
      'а изменения уходят на сервер очередью операций (конфликты разрешаются по времени изменения).</div>' +
    '</article>';
  }

  function bodyHtml(i, s, deep) {
    var rows = [
      ['Режим', syncModeText(i)],
      ['Адрес сервера', i.health ? '<code>' + U.escapeHtml(i.url) + '</code>' : '—'],
      ['Токен доступа', i.token ? '🔑 задан' : '— не задан'],
      ['Ревизия файла состояния', i.revision ? 'r' + i.revision : '—'],
      ['Обновлено на сервере', i.health && i.health.updatedAt ? formatDateTime(i.health.updatedAt) : '—'],
      ['Размер state.js', i.health && i.health.size ? U.formatNumber(i.health.size / 1024, 1) + ' КБ' : '—'],
      ['Контрольная сумма', i.health && i.health.checksum ? '<code class="small-code">' + U.escapeHtml(i.health.checksum.slice(0, 16)) + '…</code>' : '—'],
      ['Неотправленных операций', i.pending ? '<b class="text-warn">' + i.pending + '</b>' : '0 (всё на сервере)'],
      ['Последняя синхронизация', i.lastSyncAt ? formatDateTime(i.lastSyncAt) : 'ещё не было'],
      ['Локальная копия', s.journal.length + ' записей · ' + s.movements.length + ' движений · ' + U.formatNumber(deep.length / 1024, 1) + ' КБ'],
      ['Автосинхронизация', i.autoSync ? '✅ включена (после каждого изменения и раз в минуту)' : '⏸ выключена'],
      ['Оповещения Telegram', i.health && i.health.notifications ? telegramText(i.health.notifications) : '—']
    ];
    return '<div class="stats">' + rows.map(function (row) {
      return '<div class="kv"><span>' + row[0] + '</span><b>' + row[1] + '</b></div>';
    }).join('') + '</div>' +
    (i.status === 'unauthorized' ? '<div class="notice notice--warn">Сервер найден, но нужен токен доступа. Возьмите его командой <code>npm run token</code> в папке проекта и введите в окне синхронизации.</div>' : '') +
    (i.status === 'offline' ? '<div class="notice notice--warn">Сервер недоступен — приложение продолжает работать, изменения копятся и уйдут автоматически, когда связь восстановится.</div>' : '') +
    (i.status === 'local' ? '<div class="notice">Сервер не запущен. Запустите <code>npm start</code> в папке проекта — приложение переключится на серверное хранение, пока же данные живут в localStorage.</div>' : '');
  }

  function syncModeText(i) {
    if (i.status === 'synced') return '☁️ Серверное хранилище (data/state.js)';
    if (i.status === 'pending' || i.status === 'syncing') return '☁️ Сервер + локальная копия (есть очередь)';
    if (i.status === 'offline') return '📴 Офлайн-режим, очередь сохраняется';
    if (i.status === 'unauthorized') return '🔒 Локальная копия, сервер ждёт токен';
    return '💻 Локально в браузере (localStorage)';
  }

  function telegramText(notifications) {
    if (!notifications || !notifications.telegram) return 'выключены (нет TELEGRAM_TOKEN / TELEGRAM_CHAT)';
    return '✅ включены · ежедневная проверка';
  }

  function statusIcon(code) {
    if (code === 'synced') return '☁️';
    if (code === 'pending' || code === 'syncing') return '🔄';
    if (code === 'offline' || code === 'error') return '📴';
    if (code === 'unauthorized') return '🔒';
    return '💾';
  }

  /* ---------------------------------------------------------------- модал -- */
  function modal() {
    var i = Sync.info();
    var rows = '';
    var historyBlock = '<div class="muted-sm" id="sync-history">История ревизий загружается…</div>';
    var remindersBlock = '<div class="muted-sm" id="sync-reminders">Напоминания загружаются…</div>';

    if (i.health && i.token) {
      rows =
        '<div class="stats stats--tight">' +
          '<div class="kv"><span>Ревизия</span><b>r' + i.revision + '</b></div>' +
          '<div class="kv"><span>Очередь</span><b>' + i.pending + '</b></div>' +
          '<div class="kv"><span>Размер state.js</span><b>' + (i.health.size ? U.formatNumber(i.health.size / 1024, 1) + ' КБ' : '—') + '</b></div>' +
          '<div class="kv"><span>Клиент</span><b><code class="small-code">' + U.escapeHtml(i.clientId) + '</code></b></div>' +
        '</div>';
    }

    var body = '' +
      '<div class="sync-modal">' +
        '<section class="sync-block">' +
          '<h4>1. Подключение к серверу</h4>' +
          '<div class="form-stack">' +
            '<div class="field"><label>Адрес API</label>' +
              '<input type="text" id="sync-url" placeholder="' + U.escapeHtml(global.location.origin) + '" value="' + U.escapeHtml(Sync.config().url || '') + '">' +
              '<span class="muted-sm">Пусто — тот же адрес, что и у приложения (сервер раздаёт и страницу, и API).</span></div>' +
            (i.token
              ? '<div class="row gap"><span class="pill pill--ok">🔑 Токен сохранён</span>' +
                '<button class="btn btn--ghost btn--sm" data-action="sync-logout">Выйти / удалить токен</button></div>'
              : '<form data-form="sync-login" class="form-row">' +
                  '<div class="field"><label>Токен доступа</label>' +
                  '<input type="password" name="token" autocomplete="off" placeholder="например, demo-token"></div>' +
                  '<button class="btn btn--primary" type="submit">🔓 Войти</button>' +
                '</form>' +
                '<span class="muted-sm">Токен выдаётся командой <code>npm run token</code> (или <code>npm run dev</code> — демо-режим с токеном <code>demo-token</code>). Сохраняется только в этом браузере.</span>' +
                (i.demoAuth ? '<button class="btn btn--ghost btn--sm" data-action="sync-demo-login">🔓 Войти в демо-режиме (demo-token)</button>' : '')) +
            '<div class="row gap"><button class="btn btn--ghost btn--sm" data-action="sync-apply-url">Применить адрес</button>' +
              '<button class="btn btn--ghost btn--sm" data-action="sync-connect">🔌 Проверить связь</button></div>' +
          '</div>' +
        '</section>' +

        '<section class="sync-block">' +
          '<h4>2. Обмен данными</h4>' + rows +
          '<div class="row gap wrap">' +
            '<button class="btn btn--primary" data-action="sync-now" ' + (i.token ? '' : 'disabled') + '>🔄 Синхронизировать (отправить очередь и забрать свежее)</button>' +
            '<button class="btn btn--ghost" data-action="sync-push-full" ' + (i.token ? '' : 'disabled') + '>⬆️ Отправить локальное состояние целиком</button>' +
            (i.health && i.token ? '<a class="btn btn--ghost btn--sm" href="' + U.escapeHtml(Sync.downloadServerState()) + '" download="state.js">⬇️ Скачать state.js</a>' : '') +
          '</div>' +
          '<label class="check"><input type="checkbox" id="sync-autosync" ' + (i.autoSync ? 'checked' : '') + '> Автосинхронизация: после каждого изменения, раз в минуту и при появлении сети</label>' +
        '</section>' +

        (i.token ? '<section class="sync-block"><h4>3. История ревизий data/state.js</h4>' + historyBlock +
          '<div class="muted-sm">Сервер хранит до 60 последних версий файла. Откат создаёт новую ревизию — историю не теряем.</div></section>' : '') +

        (i.token ? '<section class="sync-block"><h4>4. Напоминания (Telegram)</h4>' + remindersBlock +
          '<div class="row gap wrap"><button class="btn btn--ghost btn--sm" data-action="sync-reminders-preview">↻ Обновить список</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="sync-reminders-send">✈️ Отправить сейчас</button></div></section>' : '') +
      '</div>';

    return { title: '☁️ Сервер и синхронизация', body: body };
  }

  function open() {
    Forms.Modal.open(modal());
    wireModal();
    if (Sync.info().token) {
      loadHistory();
      loadReminders();
    }
  }

  function wireModal() {
    var autosync = document.getElementById('sync-autosync');
    if (autosync) {
      autosync.addEventListener('change', function () {
        Sync.setAutoSync(autosync.checked);
        toast(autosync.checked ? 'Автосинхронизация включена' : 'Автосинхронизация выключена', 'ok');
      });
    }
    var url = document.getElementById('sync-url');
    if (url && !url.value) url.value = Sync.config().url || '';
  }

  function loadHistory() {
    var host = document.getElementById('sync-history');
    if (!host) return;
    Sync.history(30).then(function (json) {
      lastHistory = json.revisions || [];
      if (!host.isConnected) return;
      if (!lastHistory.length) { host.innerHTML = '<div class="muted-sm">Ревизий пока нет.</div>'; return; }
      host.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>Файл</th><th>Ревизия</th><th>Время</th><th>Записей</th><th>Размер</th><th></th></tr></thead><tbody>' +
        lastHistory.map(function (r, idx) {
          var isCurrent = idx === 0;
          return '<tr' + (isCurrent ? ' class="row-ok"' : '') + '>' +
            '<td><code class="small-code">' + U.escapeHtml(r.file) + '</code></td>' +
            '<td>' + (r.revision === undefined ? '—' : 'r' + r.revision) + '</td>' +
            '<td>' + (r.updatedAt || r.mtime ? formatDateTime(r.updatedAt || r.mtime) : '—') + '</td>' +
            '<td>' + (r.journal === undefined ? '—' : r.journal) + '</td>' +
            '<td>' + U.formatNumber(r.size / 1024, 1) + ' КБ</td>' +
            '<td>' + (isCurrent ? '<span class="pill pill--ok">текущая</span>' :
              '<button class="btn btn--ghost btn--sm" data-action="sync-restore" data-file="' + U.escapeHtml(r.file) + '">↩️ Откатить</button>') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>';
    }).catch(function (e) {
      if (host.isConnected) host.innerHTML = '<div class="notice notice--warn">Не удалось получить историю: ' + U.escapeHtml(e.message) + '</div>';
    });
  }

  function loadReminders() {
    var host = document.getElementById('sync-reminders');
    if (!host) return;
    Sync.reminders().then(function (json) {
      lastReminders = json;
      if (!host.isConnected) return;
      var list = (json.reminders || json.items || []).filter(function (r) { return r.level !== 'ok'; });
      var icon = { danger: '❌', warn: '⚠️', info: 'ℹ️', ok: '✅' };
      if (!list.length) { host.innerHTML = '<div class="notice notice--ok">✅ Напоминаний нет: поверки в порядке, показания переданы, долгов нет.</div>'; return; }
      host.innerHTML = '<ul class="tick-list">' + list.map(function (r) {
        return '<li><b>' + U.escapeHtml(r.title || '') + '</b> — ' + U.escapeHtml(r.text || '') + '</li>';
      }).join('') + '</ul>' +
      '<div class="muted-sm">Канал: ' + (json.telegramConfigured ? '✅ Telegram настроен' : 'Telegram не настроен — напоминания видны только в интерфейсе') + '</div>';
    }).catch(function (e) {
      if (host.isConnected) host.innerHTML = '<div class="notice notice--warn">Не удалось получить напоминания: ' + U.escapeHtml(e.message) + '</div>';
    });
  }

  function refresh() {
    var badgeHost = document.getElementById('sync-badge');
    if (badgeHost) badgeHost.innerHTML = badge();
    var slot = document.querySelector('[data-sync-slot="body"]');
    if (slot) {
      var i = Sync.info();
      var deep = JSON.stringify(State.snapshotForServer());
      slot.innerHTML = bodyHtml(i, State.get(), deep);
    }
  }

  function toast(message, kind, timeout) {
    var App = global.ZHKX && global.ZHKX.App;
    if (App && App.toast) return App.toast(message, kind, timeout);
    console.log('[sync]', message);
  }

  var SyncUI = {
    badge: badge,
    toast: toast,
    dataCard: dataCard,
    modal: modal,
    open: open,
    refresh: refresh,
    loadHistory: loadHistory,
    loadReminders: loadReminders,
    statusTone: statusTone,
    shortLabel: shortLabel,
    formatDateTime: formatDateTime
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.SyncUI = SyncUI;
})(typeof window !== 'undefined' ? window : globalThis);
