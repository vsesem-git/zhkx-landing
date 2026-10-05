/* ============================================================================
 *  UI / APP — точка входа: роутинг разделов, обработка событий, диаграммы
 *  ---------------------------------------------------------------------------
 *  Собирает всё вместе: Views (разметка), Forms (ввод данных), Core (расчёты и
 *  состояние), Charts (визуализация). События обрабатываются делегированием по
 *  атрибутам data-action / data-form — никаких inline-обработчиков в HTML.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Data = global.ZHKX.Data;
  var U = global.ZHKX.Utils;
  var Engine = global.ZHKX.TariffEngine;
  var State = global.ZHKX.State;
  var Analytics = global.ZHKX.Analytics;
  var Views = global.ZHKX.Views;
  var Forms = global.ZHKX.Forms;
  var Charts = global.ZHKX.Charts;
  var Sync = global.ZHKX.Sync;
  var SyncUI = global.ZHKX.SyncUI;

  var TABS = [
    { id: 'dashboard', label: 'Дашборд', icon: '📊' },
    { id: 'entry', label: 'Калькулятор', icon: '🧮' },
    { id: 'objects', label: 'Объекты', icon: '🏠' },
    { id: 'wallet', label: 'Авансы', icon: '💰' },
    { id: 'journal', label: 'Журнал', icon: '🧾' },
    { id: 'verification', label: 'Госповерка', icon: '⏱️' },
    { id: 'archive', label: 'Водомеры', icon: '💧' },
    { id: 'tariffs', label: 'Тарифы', icon: '📚' },
    { id: 'data', label: 'Данные', icon: '💾' }
  ];

  var App = {
    view: 'dashboard',
    filters: {},
    chartMonths: 12,
    ready: false,

    /* -------------------------------------------------------------- старт -- */
    init: function () {
      if (this.ready) return;
      State.load();

      if (!State.hasAnyData()) {
        /* Первый запуск: наполняем демо-историей, чтобы интерфейс был «живым».
           Любые данные можно очистить в разделе «Данные». */
        State.seedDemo({ months: 12 });
        this.firstRunSeeded = true;
      }

      this.period = this.resolvePeriod();
      this.applyTheme();
      this.buildTabs();
      this.buildTopbar();
      this.bind();
      this.render();

      Charts.init().then(function () { App.renderCharts(); });

      if (this.firstRunSeeded) {
        this.toast('Загружена демо-история за 12 месяцев. Очистить её можно в разделе «Данные».', 'ok', 9000);
      }
      this.updateStorageNote();
      this.initSync();
      this.ready = true;
    },

    /* ------------------------------------------------------- синхронизация */
    initSync: function () {
      this.renderSyncBadge();
      if (!Sync) return;
      Sync.onStatusChange(function (status) {
        App.renderSyncBadge();
        App.updateStorageNote();
        /* Серверные данные изменились — перерисовываем раздел */
        if (status.code === 'synced' || status.code === 'local') {
          if (App.view === 'data') App.render();
        }
      });
      Sync.start().then(function () {
        App.renderSyncBadge();
        var info = Sync.info();
        if (info.status === 'synced') {
          App.buildTopbar();
          App.render();
          App.toast('Данные загружены с сервера: ревизия r' + info.revision, 'ok', 6000);
        } else if (info.status === 'unauthorized' && info.demoAuth) {
          /* Песочница запущена с ZHKX_DEMO_AUTH=1 — подключаемся без ввода токена */
          Sync.login('demo-token').then(function () {
            App.buildTopbar();
            App.render();
            App.toast('Демо-режим сервера: вход выполнен автоматически (токен demo-token), данные загружены.', 'ok', 8000);
          }).catch(function (e) {
            App.toast('Автовход не удался: ' + e.message, 'warn');
          });
        } else if (info.status === 'unauthorized') {
          App.toast('Сервер найден: введите токен доступа в разделе «Данные» → «Сервер и синхронизация».', 'info', 12000);
        }
        if (info.pending && info.token) App.flushSync(true);
      });
    },

    renderSyncBadge: function () {
      var host = document.getElementById('sync-badge');
      if (host && SyncUI) host.innerHTML = SyncUI.badge();
    },

    /** Отправить накопленные изменения и забрать свежие данные */
    flushSync: function (silent) {
      if (!Sync) return Promise.resolve();
      return Sync.flush().then(function (res) {
        if (!silent && res && res.sent) {
          App.toast('На сервер отправлено операций: ' + res.sent + ' · ревизия r' + res.revision, 'ok');
        }
        return res;
      }).catch(function (err) {
        if (!silent) App.toast('Синхронизация не удалась: ' + err.message + ' — изменения сохранены в очереди.', 'warn', 8000);
        return null;
      });
    },


    /**
     * Период, который открывается при загрузке: сохранённый пользователем,
     * иначе текущий календарный месяц; а если за текущий месяц записей ещё нет —
     * последний месяц, по которому есть начисления (удобно в начале месяца).
     */
    resolvePeriod: function () {
      var stored = State.getSetting('activePeriod', null);
      var current = U.currentPeriod();
      /* Сохранённый период уважаем, но если это текущий календарный месяц и он
         ещё не заполнен — открываем последний месяц с начислениями. */
      if (stored && (stored !== current || State.entries({ period: stored }).length)) return stored;
      if (State.entries({ period: current }).length) return current;
      var periods = State.entries({}).map(function (e) { return e.period; }).sort();
      if (periods.length && periods[periods.length - 1] < current) return periods[periods.length - 1];
      return current;
    },

    /* ------------------------------------------------------- тема и топбар */
    applyTheme: function () {
      var theme = State.getSetting('theme', 'dark');
      document.documentElement.setAttribute('data-theme', theme);
      var btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = theme === 'light' ? '🌙 Тёмная тема' : '☀️ Светлая тема';
    },

    toggleTheme: function () {
      var next = State.getSetting('theme', 'dark') === 'light' ? 'dark' : 'light';
      State.setSetting('theme', next);
      this.applyTheme();
      this.renderCharts();
    },

    buildTabs: function () {
      var nav = document.getElementById('tabs');
      if (!nav) return;
      nav.innerHTML = TABS.map(function (t) {
        return '<button class="tab" role="tab" data-action="tab" data-view="' + t.id + '" aria-selected="false">' +
          '<span class="tab__icon">' + t.icon + '</span><span class="tab__label">' + t.label + '</span></button>';
      }).join('');
    },

    buildTopbar: function () {
      var periodSelect = document.getElementById('period-select');
      if (periodSelect) {
        var periods = [];
        for (var i = 2; i >= -18; i--) periods.push(U.addMonths(U.currentPeriod(), i));
        periodSelect.innerHTML = periods.map(function (p) {
          return '<option value="' + p + '">' + U.escapeHtml(U.periodLabel(p)) + '</option>';
        }).join('');
        periodSelect.value = this.period;
      }
      var objSelect = document.getElementById('object-select');
      if (objSelect) {
        objSelect.innerHTML = State.effectiveObjects().map(function (o) {
          return '<option value="' + o.id + '">№' + o.index + ' · ' + U.escapeHtml(o.label) + ' · ' + U.escapeHtml(o.address.city) + '</option>';
        }).join('');
        objSelect.value = State.activeObjectId();
      }
    },

    updateStorageNote: function () {
      var el = document.getElementById('storage-note');
      if (!el) return;
      if (!State.isStorageAvailable()) {
        el.innerHTML = '⚠️ localStorage недоступен (приватный режим?). Данные живут только до закрытия вкладки — выгрузите JSON-бэкап.';
        el.className = 'storage-note storage-note--warn';
      } else {
        var n = State.get().journal.length;
        var i = Sync ? Sync.info() : null;
        var storage = i && i.status === 'synced'
          ? '☁️ данные на сервере (ревизия r' + i.revision + ') + локальная копия'
          : '✅ localStorage активен';
        var pending = i && i.pending ? ' · в очереди: ' + i.pending : '';
        el.innerHTML = storage + ' · записей: ' + n + pending + ' · обновлено ' + new Date().toLocaleTimeString('ru-RU');
        el.className = i && (i.status === 'offline' || i.status === 'error') ? 'storage-note storage-note--warn' : 'storage-note';
      }
    },

    /* ------------------------------------------------------------- события */
    bind: function () {
      document.addEventListener('click', function (evt) { App.onClick(evt); });
      document.addEventListener('submit', function (evt) { App.onSubmit(evt); });
      document.addEventListener('input', function (evt) {
        var t = evt.target;
        if (t && t.matches('[data-filter="verificationDate"]')) {
          App.verificationDate = t.value || U.todayISO();
          App.render();
          return;
        }
        if (t && t.matches('[data-filter]')) App.applyFilter(t);
      });
      document.addEventListener('change', function (evt) {
        var t = evt.target;
        if (!t) return;
        if (t.matches('[data-filter]')) App.applyFilter(t);
      });
      var periodSelect = document.getElementById('period-select');
      if (periodSelect) {
        periodSelect.addEventListener('change', function () {
          App.period = periodSelect.value;
          State.setSetting('activePeriod', App.period);
          App.render();
        });
      }
      var objSelect = document.getElementById('object-select');
      if (objSelect) {
        objSelect.addEventListener('change', function () {
          State.setSetting('activeObjectId', objSelect.value);
          Forms.Entry.draft = null;
          App.render();
        });
      }
    },

    applyFilter: function (target) {
      var key = target.getAttribute('data-filter');
      this.filters[key] = target.value;
      if (key !== 'q') {
        this.render();
      } else {
        /* живой поиск по журналу без потери фокуса */
        var q = target.value;
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(function () {
          App.filters.q = q;
          App.renderJournalOnly(q);
        }, 260);
      }
    },

    renderJournalOnly: function (q) {
      if (this.view !== 'journal') return;
      var host = document.getElementById('view-host');
      this.filters.q = q;
      host.innerHTML = Views.journalView(this.filters);
      var input = host.querySelector('[data-filter="q"]');
      if (input) { input.focus(); input.setSelectionRange(q.length, q.length); }
    },

    onClick: function (evt) {
      var el = evt.target.closest('[data-action]');
      if (!el) return;
      var action = el.getAttribute('data-action');
      var handlers = {
        'tab': function () { App.setView(el.getAttribute('data-view')); },
        'theme': function () { App.toggleTheme(); },
        'period-prev': function () { App.shiftPeriod(-1); },
        'period-next': function () { App.shiftPeriod(1); },
        'modal-close': function () { Forms.Modal.close(); },
        'add-deposit': function () {
          var spec = Forms.depositModal(el.getAttribute('data-object'), el.getAttribute('data-service'));
          Forms.Modal.open(spec);
        },
        'fill-deposit': function () {
          var form = el.closest('form');
          if (form) {
            var input = form.querySelector('[name="amount"]');
            if (input) {
              input.value = el.getAttribute('data-amount');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.focus();
            }
          }
        },
        'edit-service': function () {
          Forms.Modal.open(Forms.serviceModal(el.getAttribute('data-object'), el.getAttribute('data-service')));
        },
        'edit-meter': function () {
          Forms.Modal.open(Forms.meterModal(el.getAttribute('data-object'), el.getAttribute('data-service')));
        },
        'edit-area': function () {
          Forms.Modal.open(Forms.areaModal(el.getAttribute('data-object')));
        },
        'reset-override': function () {
          var objId = el.getAttribute('data-object');
          var serviceId = el.getAttribute('data-service');
          if (!global.confirm('Вернуть значения из реестра (data-слой)? Пользовательские правки будут удалены.')) return;
          State.resetOverrides(objId, serviceId || null);
          Forms.Modal.close();
          App.toast('Значения возвращены к реестру', 'ok');
          App.render();
        },
        'delete-movement': function () {
          if (!global.confirm('Удалить это движение кошелька?')) return;
          State.removeMovement(el.getAttribute('data-movement'));
          App.toast('Движение удалено', 'warn');
          App.render();
        },
        'delete-entry': function () {
          var entryId = el.getAttribute('data-entry');
          var entry = State.findEntry(entryId);
          if (!entry) return;
          if (!global.confirm('Удалить начисление за ' + U.periodLabel(entry.period) + ' на ' + U.formatMoney(entry.amount) + '? Связанное движение в кошельке тоже будет удалено.')) return;
          State.removeEntry(entryId);
          App.toast('Запись удалена', 'warn');
          App.render();
        },
        'toggle-breakdown': function () {
          var id = el.getAttribute('data-entry');
          var row = document.querySelector('[data-entry-detail="' + id + '"]');
          if (row) row.hidden = !row.hidden;
        },
        'edit-entry': function () {
          var spec = Forms.entryEditModal(el.getAttribute('data-entry'));
          if (spec) Forms.Modal.open(spec);
        },
        'repeat-entry': function () {
          var e = State.findEntry(el.getAttribute('data-entry'));
          if (!e) return;
          App.setView('entry');
          var d = Forms.Entry.draft;
          d.objectId = e.objectId;
          d.serviceId = e.serviceId;
          d.period = U.currentPeriod();
          d.note = 'На основании ' + U.periodLabel(e.period) + (e.note ? ' · ' + e.note : '');
          d.amountOverride = null;
          Forms.Entry.autoAmount = true;
          Forms.Entry.syncReadingsFromHistory();
          Forms.Entry.renderDynamic();
          Forms.Entry.updatePreview();
          App.refreshSelectors();
        },
        'quick-entry': function () {
          App.setView('entry');
          Forms.Entry.draft = Forms.Entry.defaultDraft();
          Forms.Entry.draft.objectId = el.getAttribute('data-object');
          Forms.Entry.draft.period = App.period;
          Forms.Entry.autoAmount = true;
          Forms.Entry.syncReadingsFromHistory();
          Forms.Entry.renderDynamic();
          Forms.Entry.updatePreview();
          App.refreshSelectors();
        },
        'open-wallet': function () {
          State.setSetting('walletFilterObject', el.getAttribute('data-object'));
          App.setView('wallet');
        },
        'journal-for': function () {
          App.filters = { objectId: el.getAttribute('data-object') };
          App.setView('journal');
        },
        'goto-object': function () {
          App.setView('objects');
          var id = el.getAttribute('data-object');
          setTimeout(function () {
            var card = document.getElementById('object-' + id);
            if (card) {
              card.scrollIntoView({ behavior: 'smooth', block: 'center' });
              card.classList.add('is-flash');
              setTimeout(function () { card.classList.remove('is-flash'); }, 1600);
            }
          }, 60);
        },
        'journal-reset': function () {
          App.filters = {};
          App.render();
        },
        'sync-modal': function () { if (SyncUI) SyncUI.open(); },
        'sync-connect': function () {
          var urlInput = document.getElementById('sync-url');
          var apply = urlInput && (Sync.config().url || '') !== urlInput.value.trim().replace(/\/+$/, '');
          (apply ? Sync.setServerUrl(urlInput.value) : Sync.connect()).then(function () {
            App.renderSyncBadge();
            var i = Sync.info();
            App.toast(i.health ? 'Сервер отвечает: ревизия r' + i.revision : 'Сервер не отвечает — работаем локально', i.health ? 'ok' : 'warn', 7000);
            if (i.health && i.token) {
              App.buildTopbar();
              App.render();
            }
          });
        },
        'sync-apply-url': function () {
          var urlInput = document.getElementById('sync-url');
          if (!urlInput) return;
          Sync.setServerUrl(urlInput.value).then(function () {
            App.toast('Адрес сервера сохранён', 'ok');
            App.renderSyncBadge();
          });
        },
        'sync-now': function () {
          Sync.flush({ force: true }).then(function (res) {
            App.toast('Синхронизировано: отправлено ' + (res.sent || 0) + ', ревизия r' + (res.revision !== undefined ? res.revision : Sync.info().revision), 'ok');
            App.buildTopbar();
            App.render();
          }).catch(function (e) {
            App.toast('Не удалось синхронизировать: ' + e.message, 'warn', 8000);
          });
        },
        'sync-push-full': function () {
          if (!global.confirm('Отправить локальное состояние на сервер целиком? Текущее серверное содержимое data/state.js будет заменено (прежняя версия останется в истории ревизий).')) return;
          Sync.pushFullState('manual-full-push').then(function () {
            App.toast('Локальное состояние выгружено на сервер', 'ok');
            App.render();
          }).catch(function (e) {
            App.toast('Не удалось выгрузить: ' + e.message, 'warn', 8000);
          });
        },
        'sync-demo-login': function () {
          Sync.login('demo-token').then(function () {
            App.buildTopbar();
            App.render();
            App.toast('Демо-режим: данные загружены с сервера', 'ok');
          }).catch(function (e) { App.toast('Вход не выполнен: ' + e.message, 'bad'); });
        },
        'sync-logout': function () {
          Sync.logout();
          App.renderSyncBadge();
          App.toast('Токен удалён: приложение работает с локальной копией', 'warn');
          App.render();
        },
        'sync-restore': function () {
          var file = el.getAttribute('data-file');
          if (!global.confirm('Откатить состояние на ревизию ' + file + '? Текущая версия тоже останется в истории.')) return;
          Sync.restore(file).then(function (json) {
            Forms.Modal.close();
            App.toast('Состояние откатено к ' + file + ' (новая ревизия r' + (json.revision || Sync.info().revision) + ')', 'ok', 8000);
            App.buildTopbar();
            App.render();
          }).catch(function (e) {
            App.toast('Откат не удался: ' + e.message, 'bad');
          });
        },
        'sync-reminders-preview': function () { if (SyncUI) SyncUI.loadReminders(); },
        'sync-reminders-send': function () {
          Sync.sendReminders().then(function (json) {
            App.toast(json.sent ? 'Напоминания отправлены в Telegram (' + json.sent + ' шт.)' : 'Напоминаний нет — отправлять нечего', json.sent ? 'ok' : 'info');
            if (SyncUI) SyncUI.loadReminders();
          }).catch(function (e) {
            App.toast('Не удалось отправить: ' + e.message, 'warn', 8000);
          });
        },
        'export-json': function () { App.exportBackup(); },
        'export-csv': function () { App.exportCSV(); },
        'export-server-backup': function () { App.exportServerBackup(); },
        'seed-demo': function () {
          if (!global.confirm('Наполнить систему демонстрационной историей за 12 месяцев? Текущие данные будут заменены.')) return;
          State.seedDemo({ months: 12 });
          App.toast('Демо-данные загружены', 'ok');
          App.render();
          App.flushSync(true);
        },
        'reset-data': function () {
          if (!global.confirm('Полностью очистить журнал, кошельки и показания? Правки тарифов также будут сброшены.')) return;
          State.reset();
          App.filters = {};
          App.toast('Все пользовательские данные удалены', 'warn');
          App.flushSync(true);
          App.render();
        },
        'verification-today': function () {
          App.verificationDate = U.todayISO();
          App.render();
          App.toast('Статусы поверок пересчитаны на ' + U.formatDateISO(App.verificationDate), 'ok');
        },
        'chart-months': function () {
          App.chartMonths = U.toNumber(el.getAttribute('data-months'), 12);
          Array.prototype.forEach.call(document.querySelectorAll('[data-action="chart-months"]'), function (b) { b.classList.remove('is-active'); });
          el.classList.add('is-active');
          App.renderCharts();
        },
        'dash-filter': function () {
          var id = el.getAttribute('data-object');
          var current = State.getSetting('dashObjectFilter', null);
          State.setSetting('dashObjectFilter', current === id ? null : id);
          App.render();
        },
        'expand-all': function () {
          Array.prototype.forEach.call(document.querySelectorAll('.card--object'), function (c) { c.classList.remove('is-collapsed'); });
        },
        'collapse-all': function () {
          Array.prototype.forEach.call(document.querySelectorAll('.card--object'), function (c) { c.classList.add('is-collapsed'); });
        },
        'toggle-object': function () {
          var card = el.closest('.card--object');
          if (card) card.classList.toggle('is-collapsed');
        },
        'open-archive': function () {
          App.archiveObjectId = el.getAttribute('data-object') || '';
          App.setView('archive');
        },
        'import-archive': function () {
          var objId = el.getAttribute('data-object');
          var includeZero = el.getAttribute('data-zero') === '1';
          var overwrite = el.getAttribute('data-overwrite') === '1';
          var obj = State.effectiveObject(objId);
          if (overwrite && !global.confirm('Пересчитать суммы уже перенесённых месяцев архива по текущему графику тарифов?\n' +
            'Ручные правки сумм за эти месяцы будут заменены расчётными.')) return;
          var res = State.importWaterArchive(objId, { includeZero: includeZero, overwrite: overwrite });
          if (!res.ok) return App.toast(res.error, 'bad');
          App.toast('Архив водомера (№' + obj.index + ' ' + obj.label + '): перенесено ' + res.imported +
            (res.replaced ? ' / пересчитано ' + res.replaced : '') +
            ' ' + U.plural(res.imported, 'месяц', 'месяца', 'месяцев') +
            (res.skipped ? ' · пропущено ' + res.skipped : '') +
            ' · на сумму ' + U.formatMoney(res.total), 'ok', 9000);
          App.render();
        },
        'export-archive': function () {
          var objId = el.getAttribute('data-object');
          var obj = State.effectiveObject(objId);
          var summary = Analytics.waterArchiveSummary(objId);
          var schedule = State.waterSchedule(Data.OBJECTS[0].id);
          var head = ['Период', 'Показание, м³', 'Расход, м³', 'Тариф, руб/м³', 'Тариф', 'Начислено, руб'];
          var lines = [head.join(';')].concat(summary.archive.map(function (rec) {
            var resolved = ZHKX.TariffEngine.resolveWaterRateKey(obj, rec.period, schedule);
            var bill = ZHKX.TariffEngine.waterBill(rec.consumption, resolved.rateKey);
            return [rec.period, rec.reading, rec.consumption, resolved.rate, '"' + resolved.label + '"', U.round(bill.total, 2)].join(';');
          }));
          U.downloadFile('zhkx-vodomer-' + obj.account + '-' + U.todayISO() + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv');
          App.toast('CSV архива водомера выгружен (' + summary.months + ' записей)', 'ok');
        },
        'water-schedule-remove': function () {
          var period = el.getAttribute('data-period');
          if (!global.confirm('Удалить строку графика тарифов с ' + U.periodLabel(period) + '?')) return;
          State.removeWaterScheduleRow(Data.OBJECTS[0].id, period);
          App.toast('Строка графика удалена', 'warn');
          App.render();
        },
        'water-schedule-reset': function () {
          if (!global.confirm('Сбросить график тарифов воды к базовому (актуальный тариф 47,96 ₽/м³) для всех объектов?')) return;
          Data.OBJECTS.forEach(function (o) { State.resetWaterSchedule(o.id); });
          App.toast('График тарифов сброшен к базовому', 'ok');
          App.render();
        },
        'water-schedule-apply-all': function () {
          var schedule = State.waterSchedule(Data.OBJECTS[0].id);
          Data.OBJECTS.forEach(function (o) { State.setWaterSchedule(o.id, schedule); });
          App.toast('График тарифов применён ко всем 6 объектам', 'ok');
          App.render();
        },
        'set-water-default': function () {
          var key = el.getAttribute('data-rate-key');
          State.setSetting('waterRateKey', key);
          Data.OBJECTS.forEach(function (o) {
            State.setServiceOverride(o.id, 'water', { rateKey: key });
          });
          App.toast('Основной тариф воды: ' + Data.WATER_TARIFFS[key].label + ' (' + U.formatNumber(Data.WATER_TARIFFS[key].rate, 2) + ' ₽/м³)', 'ok');
          App.render();
        }
      };
      var fn = handlers[action];
      if (fn) { evt.preventDefault(); fn(evt); }
    },

    onSubmit: function (evt) {
      var form = evt.target.closest('[data-form]');
      if (!form) return;
      evt.preventDefault();
      var kind = form.getAttribute('data-form');
      var data = new FormData(form);
      var payload = {};
      data.forEach(function (value, key) { payload[key] = value; });

      try {
        if (kind === 'deposit') {
          var objId = form.getAttribute('data-object');
          var serviceId = form.getAttribute('data-service');
          var res = State.addDeposit(objId, serviceId, payload.amount, payload.date, payload.note);
          if (!res.ok) return App.toast(res.error, 'bad');
          Forms.Modal.close();
          var f = Engine.advanceForecast(res.balance, Analytics.walletFor(objId).filter(function (w) { return w.serviceId === serviceId; })[0].monthly, App.period);
          App.toast('Аванс зачислен. ' + (f.hasForecast ? f.text : 'Баланс кошелька: ' + U.formatMoney(res.balance)), 'ok', 8000);
        } else if (kind === 'area') {
          State.setAreaOverride(form.getAttribute('data-object'), payload.area);
          Forms.Modal.close();
          App.toast('Площадь обновлена: ' + U.formatNumber(U.toNumber(payload.area), 2) + ' м²', 'ok');
        } else if (kind === 'service') {
          var patch = {};
          if (payload.rate !== undefined) patch.rate = U.toNumber(payload.rate);
          if (payload.enabled !== undefined) patch.enabled = payload.enabled === '1';
          if (payload.category) patch.category = payload.category;
          if (payload.zones) patch.zones = U.toNumber(payload.zones, 1);
          if (payload.rateKey) patch.rateKey = payload.rateKey;
          if (payload.waterAccount !== undefined) patch.account = payload.waterAccount.trim() || null;
          var meterPatch = readMeterPatch(payload);
          if (Object.keys(meterPatch).length) patch.meter = meterPatch;
          State.setServiceOverride(form.getAttribute('data-object'), form.getAttribute('data-service'), patch);
          Forms.Modal.close();
          App.toast('Параметры услуги сохранены', 'ok');
        } else if (kind === 'water-schedule') {
          var schedObj = form.getAttribute('data-object') || Data.OBJECTS[0].id;
          var added = State.addWaterScheduleRow(schedObj, {
            fromPeriod: payload.fromPeriod,
            rateKey: payload.rateKey,
            note: payload.note
          });
          if (!added.ok) { App.toast(added.error, 'bad'); return; }
          var t = Data.WATER_TARIFFS[payload.rateKey];
          App.toast('Тариф воды с ' + U.periodLabelLower(payload.fromPeriod) + ': ' + t.label + ' — ' + U.formatNumber(t.rate, 2) + ' ₽/м³', 'ok');
        } else if (kind === 'meter') {
          var patch2 = {};
          if (payload.category) patch2.category = payload.category;
          if (payload.zones) patch2.zones = U.toNumber(payload.zones, 1);
          if (payload.rateKey) patch2.rateKey = payload.rateKey;
          patch2.meter = readMeterPatch(payload);
          State.setServiceOverride(form.getAttribute('data-object'), form.getAttribute('data-service'), patch2);
          Forms.Modal.close();
          App.toast('Прибор учёта обновлён, статус поверки пересчитан', 'ok');
        } else if (kind === 'entry-edit') {
          var id = form.getAttribute('data-entry');
          State.updateEntry(id, {
            period: payload.period,
            date: payload.date,
            amount: U.toNumber(payload.amount),
            note: payload.note,
            amountSource: 'manual'
          });
          Forms.Modal.close();
          App.toast('Начисление обновлено', 'ok');
        } else if (kind === 'sync-login') {
          Sync.login(payload.token).then(function () {
            App.toast('Вход выполнен: данные загружены с сервера', 'ok');
            App.buildTopbar();
            App.render();
            if (SyncUI) SyncUI.open();
          }).catch(function (e) {
            App.toast('Вход не выполнен: ' + e.message, 'bad', 7000);
          });
          return;
        } else if (kind === 'import') {
          App.handleImport(form);
          return;
        }
        App.render();
      } catch (e) {
        console.error(e);
        App.toast('Ошибка: ' + e.message, 'bad');
      }
    },

    /* ---------------------------------------------------------- навигация -- */
    setView: function (view) {
      if (view === this.view) return;
      if (this.view === 'entry' && view !== 'entry') Forms.Entry.unmount();
      this.view = view;
      State.setSetting('lastView', view);
      this.render();
      var host = document.getElementById('view-host');
      if (host) global.scrollTo({ top: 0, behavior: 'smooth' });
    },

    shiftPeriod: function (delta) {
      this.period = U.addMonths(this.period, delta);
      State.setSetting('activePeriod', this.period);
      var sel = document.getElementById('period-select');
      if (sel) sel.value = this.period;
      this.render();
    },

    refreshSelectors: function () {
      var objSelect = document.getElementById('object-select');
      if (objSelect && Forms.Entry.draft) objSelect.value = Forms.Entry.draft.objectId;
      var periodSelect = document.getElementById('period-select');
      var p = (Forms.Entry.draft && Forms.Entry.draft.period) || this.period;
      if (periodSelect && periodSelect.value !== p && Array.prototype.some.call(periodSelect.options, function (o) { return o.value === p; })) {
        periodSelect.value = p;
      }
    },

    /* ------------------------------------------------------------ рендеринг */
    render: function () {
      var host = document.getElementById('view-host');
      if (!host) return;
      var nowISO = U.todayISO();
      var html = '';

      switch (this.view) {
        case 'entry': html = Forms.entryView(); break;
        case 'objects': html = Views.objectsView(nowISO); break;
        case 'wallet': html = Views.walletView(); break;
        case 'journal': html = Views.journalView(this.filters); break;
        case 'verification': html = Views.verificationView(this.verificationDate || nowISO); break;
        case 'archive': html = Views.archiveView(this.archiveObjectId || ''); break;
        case 'tariffs': html = Views.tariffsView(); break;
        case 'data': html = Views.dataView(); break;
        default: html = Views.dashboardView(State.get(), nowISO);
      }

      host.innerHTML = html;
      this.markActiveTab();
      this.renderCharts();

      if (this.view === 'entry') {
        Forms.Entry.mount(host);
      } else if (this.view === 'journal' && this.filters.q) {
        var input = host.querySelector('[data-filter="q"]');
        if (input) input.value = this.filters.q;
      }
      this.updateStorageNote();
      this.updateHeaderStats();
    },

    refresh: function () { this.render(); },

    markActiveTab: function () {
      var self = this;
      Array.prototype.forEach.call(document.querySelectorAll('[data-action="tab"]'), function (btn) {
        var on = btn.getAttribute('data-view') === self.view;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    },

    updateHeaderStats: function () {
      var el = document.getElementById('header-stats');
      if (!el) return;
      var k = Analytics.kpi();
      el.innerHTML =
        '<span class="hs"><b>' + U.formatMoney(k.currentTotal) + '</b> начислено за ' + U.escapeHtml(U.periodLabelShort(k.period)) + '</span>' +
        '<span class="hs hs--ok"><b>' + U.formatMoney(k.advanceTotal) + '</b> авансы</span>' +
        (k.debtTotal > 0 ? '<span class="hs hs--bad"><b>' + U.formatMoney(k.debtTotal) + '</b> долг</span>' : '') +
        (k.expiredCount > 0 ? '<span class="hs hs--bad">❌ ' + k.expiredCount + ' поверок просрочено</span>' : '');
      var engineEl = document.getElementById('chart-engine');
      if (engineEl) engineEl.textContent = 'Диаграммы: ' + Charts.engineLabel();
    },

    /* ----------------------------------------------------------- диаграммы */
    renderCharts: function () {
      if (this.view !== 'dashboard') return;
      if (Charts.currentEngine() === 'pending') return;
      var filterId = State.getSetting('dashObjectFilter', null);

      /* 1. Структура расходов */
      var pie = filterId ? Analytics.pieByService(this.period) : Analytics.pieByObject(this.period);
      var pieData = filterId ? pie : pie;
      Charts.render('chart-service', {
        type: 'doughnut',
        data: {
          labels: pieData.labels,
          datasets: [{
            data: pieData.values,
            backgroundColor: pieData.colors,
            borderColor: 'transparent',
            borderWidth: 2,
            hoverOffset: 6
          }]
        }
      });
      this.renderLegend('legend-service', pieData, Analytics.summaryForPeriod(this.period, filterId ? { objectId: filterId } : null).total);

      /* 2. Начисления по объектам */
      var byObj = Analytics.pieByObject(this.period);
      Charts.render('chart-object', {
        type: 'doughnut',
        data: {
          labels: byObj.labels,
          datasets: [{ data: byObj.values, backgroundColor: byObj.colors, borderColor: 'transparent', borderWidth: 2, hoverOffset: 6 }]
        }
      });
      this.renderLegend('legend-object', byObj, Analytics.summaryForPeriod(this.period).total);

      /* 3. Динамика по месяцам */
      var monthly = Analytics.monthlyChart(this.chartMonths, filterId);
      Charts.render('chart-monthly', {
        type: 'bar',
        data: {
          labels: monthly.labels,
          datasets: [{
            label: 'Начислено, ₽',
            data: monthly.values,
            backgroundColor: 'rgba(59,130,246,0.75)',
            borderColor: '#3b82f6',
            borderWidth: 0,
            borderRadius: 4
          }]
        }
      });
    },

    renderLegend: function (hostId, data, total) {
      var host = document.getElementById(hostId);
      if (!host) return;
      if (!data.values.some(function (v) { return v > 0; })) {
        host.innerHTML = '<span class="muted-sm">Нет начислений за период</span>';
        return;
      }
      host.innerHTML = data.labels.map(function (label, i) {
        var value = data.values[i];
        var share = total > 0 ? (value / total * 100) : 0;
        var color = data.colors[i] || '#64748b';
        return '<div class="legend__item">' +
          '<i class="dot" style="background:' + color + '"></i>' +
          '<span class="legend__label">' + U.escapeHtml(label) + '</span>' +
          '<span class="legend__value">' + U.formatMoney(value) + '</span>' +
          '<span class="legend__share">' + U.formatPercent(share, 1) + '</span>' +
        '</div>';
      }).join('');
    },

    onChartEngineReady: function (engine) {
      var engineEl = document.getElementById('chart-engine');
      if (engineEl) engineEl.textContent = 'Диаграммы: ' + Charts.engineLabel();
      /* Перерисовали резервным рендерером, а Chart.js всё-таки загрузился —
         один раз перестраиваем диаграммы на «полноценном» движке. */
      if (this.ready && engine === 'chartjs' && !this._engineUpgraded) {
        this._engineUpgraded = true;
        this.renderCharts();
      }
    },

    /* ----------------------------------------------------- экспорт/импорт -- */
    exportBackup: function () {
      var json = State.exportJSON(true);
      U.downloadFile(State.backupFilename(), json, 'application/json');
      this.toast('Бэкап скачан: ' + State.backupFilename(), 'ok');
    },

    /** Резервная копия прямо с сервера (включая серверную обвязку) */
    exportServerBackup: function () {
      if (!Sync || !Sync.info().health) return this.toast('Сервер не подключён', 'warn');
      var url = Sync.info().url + '/api/export';
      global.fetch(url, { headers: { Authorization: 'Bearer ' + Sync.config().token } })
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'zhkx-server-backup-' + U.todayISO() + '.json';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
          App.toast('Серверный бэкап скачан', 'ok');
        })
        .catch(function (e) { App.toast('Не удалось скачать: ' + e.message, 'bad'); });
    },

    exportCSV: function () {
      var list = State.entries(this.view === 'journal' ? this.filters : {});
      if (!list.length) return this.toast('Нечего экспортировать', 'warn');
      var csv = Analytics.journalToCSV(list);
      var name = 'zhkx-journal-' + U.todayISO() + '.csv';
      U.downloadFile(name, csv, 'text/csv');
      this.toast('Журнал выгружен: ' + name + ' (' + list.length + ' записей)', 'ok');
    },

    handleImport: function (form) {
      var fileInput = form.querySelector('[name="file"]');
      var mode = form.querySelector('[name="mode"]').value;
      var file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) return this.toast('Выберите файл резервной копии', 'bad');
      var self = this;
      U.readFileAsText(file).then(function (text) {
        var res = State.importJSON(text, { mode: mode });
        self.toast(mode === 'merge'
          ? 'Импорт выполнен: добавлено ' + res.added + ' записей, пропущено дублей ' + res.skipped
          : 'Данные восстановлены: записей ' + res.journal + ', движений ' + res.movements, 'ok', 8000);
        Forms.Entry.draft = null;
        self.buildTopbar();
        self.render();
        self.flushSync(true);
      }).catch(function (e) {
        self.toast('Ошибка импорта: ' + e.message, 'bad', 9000);
      });
    },

    /* ---------------------------------------------------------------- тост */
    toast: function (message, kind, timeout) {
      var host = document.getElementById('toast-host');
      if (!host) return;
      var el = document.createElement('div');
      el.className = 'toast toast--' + (kind || 'info');
      el.innerHTML = '<span>' + U.escapeHtml(message) + '</span>' +
        '<button class="btn btn--icon" aria-label="Закрыть">✕</button>';
      el.querySelector('button').addEventListener('click', function () { el.remove(); });
      host.appendChild(el);
      setTimeout(function () {
        el.classList.add('is-out');
        setTimeout(function () { el.remove(); }, 300);
      }, timeout || 4200);
    }
  };

  function readMeterPatch(payload) {
    var patch = {};
    if (payload.meterSerial !== undefined) patch.serial = payload.meterSerial.trim() || null;
    if (payload.meterModel !== undefined) patch.model = payload.meterModel.trim() || null;
    if (payload.meterCheckDate !== undefined) patch.lastCheckDate = payload.meterCheckDate || null;
    if (payload.meterPeriodYears !== undefined && payload.meterPeriodYears !== '') patch.checkPeriodYears = U.toNumber(payload.meterPeriodYears);
    return patch;
  }

  /* --------------------------------------------------------- инициализация */
  global.ZHKX.App = App;

  function boot() {
    var report = Data.validate();
    if (!report.ok) {
      console.warn('[ZHKX] Проблемы data-слоя:', report.problems);
    }
    App.init();
    var versionEl = document.getElementById('app-version');
    if (versionEl) versionEl.textContent = 'v' + Data.APP.version + ' · схема ' + Data.APP.schemaVersion;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
