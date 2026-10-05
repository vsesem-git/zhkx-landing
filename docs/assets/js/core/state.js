/* ============================================================================
 *  CORE / STATE — состояние системы, localStorage, авансовый кошелёк, журнал
 *  ---------------------------------------------------------------------------
 *  Модель учёта построена на ЕДИНОМ РЕЕСТРЕ ДВИЖЕНИЙ (ledger / movements).
 *  Каждое движение относится к паре «объект + услуга» и имеет знак:
 *
 *      kind: 'opening'    +  перенос сальдо на начало учёта (может быть −)
 *      kind: 'deposit'    +  внесённый аванс (крупный платёж вперёд)
 *      kind: 'payment'    +  оплата начисления по квитанции
 *      kind: 'correction' ±  ручная корректировка
 *      kind: 'charge'     −  НАЧИСЛЕНИЕ за месяц (создаётся записью журнала)
 *
 *  Баланс услуги   = Σ движений.  Он же — баланс авансового кошелька:
 *      balance > 0 → остаток аванса, который будет «съеден» будущими начислениями;
 *      balance < 0 → долг (начисления превысили внесённые деньги).
 *  Начисление АВТОМАТИЧЕСКИ уменьшает аванс в момент добавления записи журнала
 *  (движение 'charge' с отрицательной суммой), что и требует ТЗ.
 *
 *  СИНХРОНИЗАЦИЯ С СЕРВЕРОМ (core/sync.js)
 *  ---------------------------------------------------------------------------
 *  Каждое изменение ставится в очередь исходящих операций (outbox) и уходит на
 *  сервер, который хранит данные в data/state.js и ведёт историю ревизий.
 *  Операции идемпотентны, удаления фиксируются «надгробиями» (tombstones),
 *  правки разрешаются по принципу «последняя по времени побеждает» (LWW) —
 *  поэтому приложение можно спокойно использовать офлайн и с двух устройств.
 *  Если сервера нет, всё продолжает работать локально (режим «Локально»).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Data = global.ZHKX && global.ZHKX.Data;
  var U = global.ZHKX && global.ZHKX.Utils;
  var Engine = global.ZHKX && global.ZHKX.TariffEngine;

  var MOVEMENT_KINDS = {
    opening: { id: 'opening', label: 'Перенос сальдо', sign: +1, icon: '🔄' },
    deposit: { id: 'deposit', label: 'Внесён аванс', sign: +1, icon: '💰' },
    payment: { id: 'payment', label: 'Оплата по квитанции', sign: +1, icon: '💳' },
    correction: { id: 'correction', label: 'Корректировка', sign: 0, icon: '✏️' },
    charge: { id: 'charge', label: 'Начисление', sign: -1, icon: '🧾' }
  };

  /* ------------------------------------------------------------- ХРАНИЛИЩЕ */
  var memoryFallback = null;
  var storageAvailable = (function () {
    try {
      var k = '__zhkx_probe__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function rawStorageGet(key) {
    if (!storageAvailable) return memoryFallback ? memoryFallback[key] || null : null;
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  function rawStorageSet(key, value) {
    if (!storageAvailable) {
      memoryFallback = memoryFallback || {};
      memoryFallback[key] = value;
      return { ok: true, degraded: true };
    }
    try {
      global.localStorage.setItem(key, value);
      return { ok: true, degraded: false };
    } catch (e) {
      return { ok: false, degraded: false, error: e };
    }
  }

  /* --------------------------------------------------------- НОВОЕ СОСТОЯНИЕ */
  function defaultSettings() {
    return {
      activePeriod: null,          // null → текущий месяц компьютера
      activeObjectId: null,        // null → первый объект
      waterRateKey: Data.WATER_DEFAULT_RATE_KEY,
      theme: 'dark',
      collapseDeposits: false
    };
  }

  function emptyObjectState() {
    return { overrides: { area: null, services: {} }, waterSchedule: null, notes: null };
  }

  function createState() {
    var now = new Date().toISOString();
    return {
      meta: {
        appId: Data.APP.id,
        schemaVersion: Data.APP.schemaVersion,
        appVersion: Data.APP.version,
        createdAt: now,
        updatedAt: now,
        revision: 0,            // ревизия на сервере, на которой основана копия
        serverUpdatedAt: null   // когда сервер последний раз менял данные
      },
      settings: defaultSettings(),
      objects: {},          // { objId: { overrides, waterSchedule, notes, _updatedAt } }
      movements: [],        // единый реестр движений
      journal: [],          // записи начислений
      meterSnapshots: {},   // { objId: { electricity:{...}, water:{...} } } — текущие показания
      tombstones: {},       // «надгробия» удалений: ключ «entry:id» → ISO-время
      outbox: []            // очередь операций для сервера (в файл на сервере не пишется)
    };
  }

  /* Нормализация/миграция загруженного состояния: гарантируем форму данных */
  function normalizeState(raw) {
    var base = createState();
    if (!raw || typeof raw !== 'object') return base;

    var state = base;
    state.meta.createdAt = (raw.meta && raw.meta.createdAt) || base.meta.createdAt;
    state.meta.updatedAt = (raw.meta && raw.meta.updatedAt) || base.meta.updatedAt;
    state.meta.schemaVersion = Data.APP.schemaVersion;
    state.meta.appVersion = Data.APP.version;
    state.meta.importedAt = (raw.meta && raw.meta.importedAt) || null;
    state.meta.migrationLog = (raw.meta && raw.meta.migrationLog) || [];
    state.meta.revision = Number((raw.meta && raw.meta.revision) || 0);
    state.meta.serverUpdatedAt = (raw.meta && raw.meta.serverUpdatedAt) || null;
    state.tombstones = (raw.tombstones && typeof raw.tombstones === 'object') ? raw.tombstones : {};
    state.outbox = Array.isArray(raw.outbox) ? raw.outbox.filter(function (o) {
      return o && o.type;
    }).map(function (o) {
      return { id: o.id || U.uid('op'), type: o.type, payload: o.payload || {}, at: o.at || new Date().toISOString() };
    }) : [];

    state.settings = Object.assign(defaultSettings(), raw.settings || {});
    if (!Data.WATER_TARIFFS[state.settings.waterRateKey]) {
      state.settings.waterRateKey = Data.WATER_DEFAULT_RATE_KEY;
    }

    if (raw.objects && typeof raw.objects === 'object') {
      Object.keys(raw.objects).forEach(function (id) {
        var o = raw.objects[id] || {};
        state.objects[id] = {
          overrides: {
            area: (o.overrides && typeof o.overrides.area === 'number') ? o.overrides.area : null,
            services: (o.overrides && o.overrides.services) || {}
          },
          waterSchedule: Array.isArray(o.waterSchedule) ? normalizeSchedule(o.waterSchedule) : null,
          notes: o.notes || null
        };
      });
    }

    state.movements = Array.isArray(raw.movements)
      ? raw.movements.filter(function (m) { return m && m.objectId && m.serviceId; })
        .map(function (m) {
          return {
            id: m.id || U.uid('mov'),
            objectId: m.objectId,
            serviceId: m.serviceId,
            kind: MOVEMENT_KINDS[m.kind] ? m.kind : 'correction',
            amount: U.round(U.toNumber(m.amount), 2),
            date: m.date || U.todayISO(),
            period: m.period || null,
            note: m.note || '',
            entryId: m.entryId || null,
            updatedAt: m.updatedAt || m.date || U.todayISO()
          };
        })
      : [];

    state.journal = Array.isArray(raw.journal)
      ? raw.journal.filter(function (e) { return e && e.objectId && e.serviceId && e.period; })
        .map(normalizeEntry)
      : [];

    state.meterSnapshots = (raw.meterSnapshots && typeof raw.meterSnapshots === 'object') ? raw.meterSnapshots : {};

    /* Мусорные движения-начисления без записи журнала удаляем (защита от битых импортов) */
    var entryIds = state.journal.reduce(function (acc, e) { acc[e.id] = true; return acc; }, {});
    state.movements = state.movements.filter(function (m) {
      return m.kind !== 'charge' || (m.entryId && entryIds[m.entryId]);
    });

    return state;
  }

  function normalizeEntry(e) {
    return {
      id: e.id || U.uid('entry'),
      objectId: e.objectId,
      serviceId: e.serviceId,
      period: e.period,
      date: e.date || (e.period ? e.period + '-01' : U.todayISO()),
      amount: U.round(U.toNumber(e.amount), 2),
      amountSource: e.amountSource === 'manual' ? 'manual' : 'auto',
      consumption: (e.consumption === null || e.consumption === undefined) ? null : U.round(U.toNumber(e.consumption), 3),
      readings: e.readings || null,
      previousReadings: e.previousReadings || null,
      rate: (e.rate === null || e.rate === undefined) ? null : U.toNumber(e.rate),
      rateKey: e.rateKey || null,
      breakdown: e.breakdown || null,
      sections: Array.isArray(e.sections) ? e.sections : [],
      origin: ['user', 'demo', 'archive'].indexOf(e.origin) !== -1 ? e.origin : 'user',
      note: e.note || '',
      createdAt: e.createdAt || new Date().toISOString(),
      updatedAt: e.updatedAt || e.createdAt || new Date().toISOString()
    };
  }

  /* ============================================ ОЧЕРЕДЬ ОПЕРАЦИЙ (OUTBOX) == */
  var opSuppressed = 0;

  /** Выполнить действие без постановки операций в очередь (импорт, демо, сброс) */
  function suppressOps(fn) {
    opSuppressed++;
    try { return fn(); } finally { opSuppressed--; }
  }

  /**
   * Записать операцию для сервера.
   * @param {string} type  upsert-entry | delete-entry | upsert-movement | delete-movement |
   *                       set-object | set-settings | set-snapshot | replace-state
   * @param {object} payload
   */
  var OUTBOX_LIMIT = 500;

  function recordOp(type, payload) {
    if (opSuppressed) return null;
    var s = get();
    var op = { id: U.uid('op'), type: type, payload: payload || {}, at: new Date().toISOString() };
    s.outbox.push(op);
    /* Долгая жизнь без сервера: очередь не должна расти бесконечно — сжимаем
       её в одну операцию «полная замена состояния». */
    if (s.outbox.length > OUTBOX_LIMIT && type !== 'replace-state') {
      s.outbox = [{
        id: U.uid('op'),
        type: 'replace-state',
        payload: { state: snapshotForServer(), reason: 'outbox-compacted' },
        at: new Date().toISOString()
      }];
      return s.outbox[0];
    }
    return op;
  }

  /** Отметить сущность удалённой: «надгробие» переживёт синхронизацию */
  function bury(kind, id, at) {
    var s = get();
    var key = kind + ':' + id;
    var stamp = at || new Date().toISOString();
    if (!s.tombstones[key] || s.tombstones[key] < stamp) s.tombstones[key] = stamp;
    return key;
  }

  function isBuried(kind, id, at) {
    var key = kind + ':' + id;
    var stamp = get().tombstones[key];
    if (!stamp) return false;
    return !at || stamp >= String(at);
  }

  function pendingOps() { return get().outbox.slice(); }
  function pendingCount() { return get().outbox.length; }

  function clearOps(ids) {
    var s = get();
    var drop = {};
    (ids || []).forEach(function (id) { drop[id] = true; });
    var before = s.outbox.length;
    s.outbox = s.outbox.filter(function (op) { return !drop[op.id]; });
    if (s.outbox.length !== before) save();
    return before - s.outbox.length;
  }

  /** Состояние для отправки на сервер: без клиентской очереди */
  function snapshotForServer() {
    var clone = U.deepClone(get());
    delete clone.outbox;
    return clone;
  }

  /* -------------------------------------------------------------- ХРАНЕНИЕ */
  var state = null;

  function load() {
    var raw = rawStorageGet(Data.APP.storageKey);
    if (!raw) { state = createState(); return state; }
    try {
      state = normalizeState(JSON.parse(raw));
    } catch (e) {
      console.warn('[ZHKX] Не удалось разобрать сохранённое состояние, создаём новое.', e);
      state = createState();
    }
    return state;
  }

  function get() {
    if (!state) load();
    return state;
  }

  var saveListeners = [];
  function onSave(fn) { if (typeof fn === 'function') saveListeners.push(fn); }

  function save() {
    var s = get();
    s.meta.updatedAt = new Date().toISOString();
    var payload = JSON.stringify(s, null, 0);
    var res = rawStorageSet(Data.APP.storageKey, payload);
    saveListeners.forEach(function (fn) { fn(s); });
    return res;
  }

  /* -------------------------------------------------- ЭФФЕКТИВНЫЕ ОБЪЕКТЫ */
  /** Копия объекта из data-слоя с наложенными пользовательскими правками */
  function effectiveObject(objId) {
    var base = Data.OBJECTS.filter(function (o) { return o.id === objId; })[0];
    if (!base) return null;
    var s = get();
    var ov = (s.objects[objId] && s.objects[objId].overrides) || { area: null, services: {} };
    var obj = U.deepClone(base);
    if (typeof ov.area === 'number' && ov.area > 0) obj.area = ov.area;
    obj.overrides = ov;
    obj.isAreaOverridden = typeof ov.area === 'number';
    Object.keys(ov.services || {}).forEach(function (sid) {
      if (!obj.services[sid]) return;
      var patch = ov.services[sid] || {};
      Object.keys(patch).forEach(function (k) {
        if (patch[k] === null || patch[k] === undefined) return;
        if (k === 'meter') {
          obj.services[sid].meter = Object.assign({}, obj.services[sid].meter || {}, patch.meter);
        } else {
          obj.services[sid][k] = patch[k];
        }
      });
      obj.services[sid].isOverridden = true;
    });
    return obj;
  }

  function effectiveObjects() {
    return Data.OBJECTS.map(function (o) { return effectiveObject(o.id); });
  }

  /** Точечная правка параметров услуги объекта (тариф, категория, зоны, ПУ) */
  function setServiceOverride(objId, serviceId, patch) {
    var s = get();
    s.objects[objId] = s.objects[objId] || emptyObjectState();
    var svc = s.objects[objId].overrides.services[serviceId] || {};
    s.objects[objId].overrides.services[serviceId] = Object.assign({}, svc, patch);
    recordOp('set-object', { objectId: objId, patch: { overrides: s.objects[objId].overrides } });
    save();
    return effectiveObject(objId);
  }

  function setAreaOverride(objId, area) {
    var s = get();
    s.objects[objId] = s.objects[objId] || emptyObjectState();
    s.objects[objId].overrides.area = (area === null || area === '') ? null : U.toNumber(area);
    recordOp('set-object', { objectId: objId, patch: { overrides: s.objects[objId].overrides } });
    save();
    return effectiveObject(objId);
  }

  function resetOverrides(objId, serviceId) {
    var s = get();
    if (!s.objects[objId]) return;
    if (serviceId) {
      delete s.objects[objId].overrides.services[serviceId];
    } else {
      s.objects[objId] = emptyObjectState();
    }
    recordOp('set-object', { objectId: objId, patch: { overrides: s.objects[objId].overrides } });
    save();
  }

  function hasOverrides(objId) {
    var s = get();
    var ov = s.objects[objId] && s.objects[objId].overrides;
    if (!ov) return false;
    if (typeof ov.area === 'number') return true;
    return Object.keys(ov.services || {}).length > 0;
  }

  /* ==================================== ГРАФИК ТАРИФОВ ВОДЫ ПО ПЕРИОДАМ == */
  function normalizeSchedule(rows) {
    return (rows || [])
      .filter(function (r) { return r && U.parsePeriod(r.fromPeriod) && Data.WATER_TARIFFS[r.rateKey]; })
      .map(function (r) {
        return { fromPeriod: r.fromPeriod, rateKey: r.rateKey, note: r.note || '' };
      })
      .sort(function (a, b) { return a.fromPeriod.localeCompare(b.fromPeriod); });
  }

  /** Действующий график тарифов воды объекта (правки пользователя или базовый) */
  function waterSchedule(objId) {
    var s = get();
    var own = s.objects[objId] && s.objects[objId].waterSchedule;
    if (own && own.length) return normalizeSchedule(own);
    return normalizeSchedule(Data.WATER_TARIFF_SCHEDULE_DEFAULT);
  }

  function isScheduleCustomized(objId) {
    var s = get();
    return !!(s.objects[objId] && s.objects[objId].waterSchedule && s.objects[objId].waterSchedule.length);
  }

  function setWaterSchedule(objId, rows) {
    var s = get();
    s.objects[objId] = s.objects[objId] || emptyObjectState();
    s.objects[objId].waterSchedule = normalizeSchedule(rows);
    recordOp('set-object', { objectId: objId, patch: { waterSchedule: s.objects[objId].waterSchedule } });
    save();
    return waterSchedule(objId);
  }

  /** Добавить/заменить строку графика: «с периода YYYY-MM действует тариф X» */
  function addWaterScheduleRow(objId, row) {
    if (!row || !U.parsePeriod(row.fromPeriod)) return { ok: false, error: 'Некорректный период.' };
    if (!Data.WATER_TARIFFS[row.rateKey]) return { ok: false, error: 'Неизвестный тариф.' };
    var rows = waterSchedule(objId).filter(function (r) { return r.fromPeriod !== row.fromPeriod; });
    rows.push({ fromPeriod: row.fromPeriod, rateKey: row.rateKey, note: row.note || '' });
    setWaterSchedule(objId, rows);
    return { ok: true, schedule: waterSchedule(objId) };
  }

  function removeWaterScheduleRow(objId, fromPeriod) {
    var rows = waterSchedule(objId).filter(function (r) { return r.fromPeriod !== fromPeriod; });
    setWaterSchedule(objId, rows);
    return { ok: true, schedule: waterSchedule(objId) };
  }

  function resetWaterSchedule(objId) {
    var s = get();
    if (s.objects[objId]) s.objects[objId].waterSchedule = null;
    recordOp('set-object', { objectId: objId, patch: { waterSchedule: null } });
    save();
    return waterSchedule(objId);
  }

  /* ==================================== АРХИВ ВОДОМЕРА (ИСТОРИЯ ПОКАЗАНИЙ) = */
  /** Архив из data-слоя + статистика + что уже перенесено в журнал */
  function waterArchiveInfo(objId) {
    var eff = effectiveObject(objId);
    var archive = (eff && eff.services.water && eff.services.water.archive) || [];
    var stats = Engine.archiveStats(archive, Data.RULES.forecastWindowMonths);
    var journalPeriods = entries({ objectId: objId, serviceId: 'water' })
      .reduce(function (acc, e) { acc[e.period] = e; return acc; }, {});
    var imported = [], pending = [];
    archive.forEach(function (rec) {
      if (journalPeriods[rec.period]) imported.push(rec.period); else pending.push(rec.period);
    });
    return {
      objectId: objId,
      account: eff.services.water.account || null,
      accountNote: eff.services.water.accountNote || null,
      stats: stats,
      archive: archive,
      importedPeriods: imported,
      pendingPeriods: pending,
      hasArchive: archive.length > 0
    };
  }

  /**
   * Перенос исторического архива водомера в журнал начислений.
   * Сумма каждого месяца считается по тарифу, действовавшему в ЭТОМ периоде
   * (селектор периодов), расход — из архива.
   * @param {object} opts { includeZero:boolean, overwrite:boolean }
   */
  function importWaterArchive(objId, opts) {
    var o = opts || {};
    var eff = effectiveObject(objId);
    var archive = (eff && eff.services.water && eff.services.water.archive) || [];
    if (!archive.length) return { ok: false, error: 'Для этого объекта архив водомера не заполнен.' };

    var includeZero = o.includeZero === true;
    var overwrite = o.overwrite === true;
    var imported = 0, replaced = 0, skipped = 0, total = 0;
    var schedule = waterSchedule(objId);

    archive.forEach(function (rec) {
      var volume = U.toNumber(rec.consumption);
      if (!includeZero && volume <= 0) { skipped++; return; }
      var existing = get().journal.filter(function (e) {
        return e.objectId === objId && e.serviceId === 'water' && e.period === rec.period;
      })[0];
      if (existing && !overwrite) { skipped++; return; }

      var resolved = Engine.resolveWaterRateKey(eff, rec.period, schedule);
      var bill = Engine.waterBill(volume, resolved.rateKey);
      var reading = U.toNumber(rec.reading);
      var payload = {
        objectId: objId,
        serviceId: 'water',
        period: rec.period,
        date: U.periodEndISO(rec.period),
        amount: bill.total,
        amountSource: 'auto',
        origin: 'archive',
        consumption: bill.volume,
        rate: bill.rate,
        rateKey: bill.rateKey,
        readings: { total: reading },
        previousReadings: { total: U.round(reading - volume, Data.RULES.volumeDecimals) },
        previousPeriod: U.addMonths(rec.period, -1),
        note: 'Архив водомера' + (rec.note ? ' · ' + rec.note : '') + ' · тариф ' + resolved.label
      };

      if (existing) { updateEntry(existing.id, payload, { silent: true }); replaced++; }
      else { addEntry(payload, { silent: true, allowDuplicate: true }); imported++; }
      total += bill.total;
    });

    save();
    return { ok: true, imported: imported, replaced: replaced, skipped: skipped, total: U.round(total, 2) };
  }

  /* ================================================ АВАНСОВЫЙ КОШЕЛЁК == */
  function movementsOf(filter) {
    var f = filter || {};
    return get().movements.filter(function (m) {
      if (f.objectId && m.objectId !== f.objectId) return false;
      if (f.serviceId && m.serviceId !== f.serviceId) return false;
      if (f.kind && m.kind !== f.kind) return false;
      return true;
    });
  }

  function sortMovements(list) {
    /* Сначала по дате; в пределах одного дня приходные движения обрабатываются
       раньше начислений — так аванс корректно покрывает начисление того же дня. */
    return list.slice().sort(function (a, b) {
      var d = String(a.date).localeCompare(String(b.date));
      if (d !== 0) return d;
      var pa = a.kind === 'charge' ? 1 : 0;
      var pb = b.kind === 'charge' ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  /** Баланс услуги объекта: > 0 — остаток аванса, < 0 — долг */
  function balance(objId, serviceId) {
    return U.round(U.sum(movementsOf({ objectId: objId, serviceId: serviceId }), function (m) { return m.amount; }), 2);
  }

  function balances(objId) {
    var out = {};
    Data.SERVICES.forEach(function (svc) { out[svc.id] = balance(objId, svc.id); });
    return out;
  }

  function advanceBalance(objId, serviceId) {
    return Math.max(0, balance(objId, serviceId));
  }

  function debtBalance(objId, serviceId) {
    return Math.max(0, -balance(objId, serviceId));
  }

  /**
   * Хронологический проход по реестру движений: какая часть каждого начисления
   * была покрыта авансом (для отображения «оплачено авансом» в журнале).
   * @returns {Object} { [entryId]: {covered:number} }
   */
  function coverageMap(objId, serviceId) {
    var list = sortMovements(movementsOf({ objectId: objId, serviceId: serviceId }));
    var running = 0;
    var map = {};
    list.forEach(function (m) {
      if (m.kind === 'charge') {
        var need = Math.abs(m.amount);
        var covered = Math.min(need, Math.max(0, running));
        if (m.entryId) map[m.entryId] = { covered: U.round(covered, 2), uncovered: U.round(need - covered, 2) };
        running -= need;
      } else {
        running += m.amount;
      }
    });
    return map;
  }

  /** Агрегированный «кошелёк авансов» по всем услугам объекта */
  function wallet(objId) {
    return Data.SERVICES.map(function (svc) {
      var bal = balance(objId, svc.id);
      var cov = coverageMap(objId, svc.id);
      return {
        serviceId: svc.id,
        label: svc.label,
        icon: svc.icon,
        color: svc.color,
        balance: bal,
        advance: Math.max(0, bal),
        debt: Math.max(0, -bal),
        coverage: cov
      };
    });
  }

  function addMovement(payload) {
    var s = get();
    var m = {
      id: payload.id || U.uid('mov'),
      objectId: payload.objectId,
      serviceId: payload.serviceId,
      kind: MOVEMENT_KINDS[payload.kind] ? payload.kind : 'correction',
      amount: U.round(U.toNumber(payload.amount), 2),
      date: payload.date || U.todayISO(),
      period: payload.period || null,
      note: payload.note || '',
      entryId: payload.entryId || null
    };
    s.movements.push(m);
    if (!payload.silent) recordOp('upsert-movement', m);
    return m;
  }

  /* ================================================== ОПЕРАЦИИ КОШЕЛЬКА == */
  /** Внести аванс (крупный платёж вперёд) в кошелёк услуги */
  function addDeposit(objId, serviceId, amount, date, note) {
    var value = U.toNumber(amount);
    if (!(value > 0)) return { ok: false, error: 'Сумма аванса должна быть больше нуля.' };
    var m = addMovement({
      objectId: objId, serviceId: serviceId, kind: 'deposit',
      amount: value, date: date || U.todayISO(), note: note || 'Аванс',
      period: U.periodOfDate(date || U.todayISO())
    });
    save();
    return { ok: true, movement: m, balance: balance(objId, serviceId) };
  }

  /** Оплатить начисление (или долг) — уменьшает задолженность */
  function addPayment(objId, serviceId, amount, date, note) {
    var value = U.toNumber(amount);
    if (!(value > 0)) return { ok: false, error: 'Сумма оплаты должна быть больше нуля.' };
    var m = addMovement({
      objectId: objId, serviceId: serviceId, kind: 'payment',
      amount: value, date: date || U.todayISO(), note: note || 'Оплата',
      period: U.periodOfDate(date || U.todayISO())
    });
    save();
    return { ok: true, movement: m, balance: balance(objId, serviceId) };
  }

  function addCorrection(objId, serviceId, amount, date, note) {
    var value = U.toNumber(amount);
    if (value === 0) return { ok: false, error: 'Сумма корректировки не может быть нулевой.' };
    var m = addMovement({
      objectId: objId, serviceId: serviceId, kind: 'correction',
      amount: value, date: date || U.todayISO(), note: note || 'Корректировка'
    });
    save();
    return { ok: true, movement: m, balance: balance(objId, serviceId) };
  }

  function removeMovement(id) {
    var s = get();
    var before = s.movements.length;
    s.movements = s.movements.filter(function (m) { return m.id !== id; });
    if (s.movements.length !== before) {
      bury('movement', id);
      recordOp('delete-movement', { id: id });
      save();
      return true;
    }
    return false;
  }

  /* ======================================================== ЖУРНАЛ ======= */
  function nextEntryId() {
    var s = get();
    return 'entry-' + String(s.journal.length + 1).padStart(4, '0') + '-' + Date.now().toString(36);
  }

  function findEntry(id) {
    return get().journal.filter(function (e) { return e.id === id; })[0] || null;
  }

  /**
   * Добавить запись начисления. Автоматически:
   *   1) рассчитывает сумму по правилам ТЗ (если не задана вручную);
   *   2) фиксирует показания счётчиков в снапшоте;
   *   3) создаёт движение 'charge' (−сумма) — аванс уменьшается сразу.
   */
  function addEntry(payload, opts) {
    var o = opts || {};
    var s = get();
    var entry = normalizeEntry(Object.assign({ id: nextEntryId(), origin: 'user' }, payload));
    entry.createdAt = new Date().toISOString();
    entry.updatedAt = null;

    var duplicate = s.journal.filter(function (e) {
      return e.objectId === entry.objectId && e.serviceId === entry.serviceId && e.period === entry.period;
    })[0];
    if (duplicate && !o.allowDuplicate) {
      return { ok: false, error: 'Дубликат', duplicate: duplicate, entry: entry };
    }

    s.journal.push(entry);
    addMovement({
      objectId: entry.objectId, serviceId: entry.serviceId, kind: 'charge',
      amount: -entry.amount, date: entry.date, period: entry.period,
      note: 'Начисление ' + U.periodLabel(entry.period), entryId: entry.id
    });

    if (entry.readings) {
      setMeterSnapshot(entry.objectId, entry.serviceId, entry.readings, entry.period);
    }

    if (!o.silent) {
      recordOp('upsert-entry', entry);
      save();
    }
    return { ok: true, entry: entry, balance: balance(entry.objectId, entry.serviceId) };
  }

  /** Обновить запись (сумма, показания, период) с пересчётом движения */
  function updateEntry(id, patch, opts) {
    var o = opts || {};
    var s = get();
    var entry = findEntry(id);
    if (!entry) return { ok: false, error: 'Запись не найдена' };

    Object.assign(entry, patch);
    entry.amount = U.round(U.toNumber(entry.amount), 2);
    entry.updatedAt = new Date().toISOString();

    s.movements = s.movements.filter(function (m) { return !(m.kind === 'charge' && m.entryId === id); });
    addMovement({
      objectId: entry.objectId, serviceId: entry.serviceId, kind: 'charge',
      amount: -entry.amount, date: entry.date, period: entry.period,
      note: 'Начисление ' + U.periodLabel(entry.period), entryId: entry.id
    });
    if (entry.readings) setMeterSnapshot(entry.objectId, entry.serviceId, entry.readings, entry.period);
    if (!o.silent) {
      recordOp('upsert-entry', entry);
      save();
    }
    return { ok: true, entry: entry, balance: balance(entry.objectId, entry.serviceId) };
  }

  function removeEntry(id) {
    var s = get();
    var before = s.journal.length;
    s.movements.filter(function (m) { return m.kind === 'charge' && m.entryId === id; })
      .forEach(function (m) { bury('movement', m.id); recordOp('delete-movement', { id: m.id }); });
    s.journal = s.journal.filter(function (e) { return e.id !== id; });
    s.movements = s.movements.filter(function (m) { return !(m.kind === 'charge' && m.entryId === id); });
    if (s.journal.length !== before) {
      bury('entry', id);
      recordOp('delete-entry', { id: id });
      save();
      return true;
    }
    return false;
  }

  function entries(filter) {
    var f = filter || {};
    return get().journal
      .filter(function (e) {
        if (f.objectId && e.objectId !== f.objectId) return false;
        if (f.serviceId && e.serviceId !== f.serviceId) return false;
        if (f.period && e.period !== f.period) return false;
        if (f.periodFrom && e.period < f.periodFrom) return false;
        if (f.periodTo && e.period > f.periodTo) return false;
        return true;
      })
      .sort(function (a, b) {
        var p = String(b.period).localeCompare(String(a.period));
        if (p !== 0) return p;
        return String(a.createdAt).localeCompare(String(b.createdAt));
      });
  }

  function lastEntry(objId, serviceId, beforePeriod) {
    var list = entries({ objectId: objId, serviceId: serviceId })
      .filter(function (e) { return !beforePeriod || e.period < beforePeriod; });
    return list[0] || null;
  }

  /* ==================================================== ПОКАЗАНИЯ ПУ ===== */
  function setMeterSnapshot(objId, serviceId, readings, period) {
    var s = get();
    s.meterSnapshots[objId] = s.meterSnapshots[objId] || {};
    s.meterSnapshots[objId][serviceId] = {
      readings: Object.assign({}, readings),
      period: period || null,
      updatedAt: new Date().toISOString()
    };
    recordOp('set-snapshot', { objectId: objId, serviceId: serviceId, patch: s.meterSnapshots[objId][serviceId] });
    return s.meterSnapshots[objId][serviceId];
  }

  function getMeterSnapshot(objId, serviceId) {
    var s = get();
    return (s.meterSnapshots[objId] && s.meterSnapshots[objId][serviceId]) || null;
  }

  /**
   * Текущие (последние известные) показания ПУ и предыдущие — для расчёта расхода.
   * Приоритет: снапшот (последняя запись) → последняя запись журнала.
   * @returns {{current:object, previous:object, previousPeriod:string|null, source:string}}
   */
  function meterState(objId, serviceId, beforePeriod) {
    var eff = effectiveObject(objId);
    var zoneCount = serviceId === 'electricity'
      ? U.toNumber(eff && eff.services.electricity.zones, 1)
      : 1;

    var last = lastEntry(objId, serviceId, beforePeriod);
    var snapshot = getMeterSnapshot(objId, serviceId);

    var current = null;
    if (last && last.readings) current = Object.assign({}, last.readings);
    else if (snapshot && snapshot.readings) current = Object.assign({}, snapshot.readings);

    var previous = null;
    var previousPeriod = null;
    if (last) {
      previous = last.previousReadings ? Object.assign({}, last.previousReadings) : null;
      previousPeriod = last.previousPeriod || null;
      if (!previous && last.readings) {
        /* Предыдущая запись журнала (более ранний период) */
        var earlier = entries({ objectId: objId, serviceId: serviceId })
          .filter(function (e) { return e.readings && e.period < last.period; });
        if (earlier[0]) {
          previous = Object.assign({}, earlier[0].readings);
          previousPeriod = earlier[0].period;
        }
      }
    }

    if (!current) current = blankReadings(serviceId, zoneCount);
    if (!previous) previous = blankReadings(serviceId, zoneCount);

    return {
      current: current,
      previous: previous,
      previousPeriod: previousPeriod,
      source: last ? 'journal' : (snapshot ? 'snapshot' : 'empty'),
      zoneCount: zoneCount
    };
  }

  function blankReadings(serviceId, zoneCount) {
    if (serviceId === 'electricity' && U.toNumber(zoneCount, 1) >= 2) return { day: 0, night: 0 };
    return { total: 0 };
  }

  function setMeterReading(objId, serviceId, values, period) {
    setMeterSnapshot(objId, serviceId, values, period || U.currentPeriod());
    save();
    return getMeterSnapshot(objId, serviceId);
  }

  /* ============================================== ЭКСПОРТ / ИМПОРТ ======= */
  function exportPayload() {
    var s = get();
    return {
      format: 'zhkx-crimea-backup',
      formatVersion: 1,
      app: {
        id: Data.APP.id,
        title: Data.APP.title,
        version: Data.APP.version,
        schemaVersion: Data.APP.schemaVersion
      },
      exportedAt: new Date().toISOString(),
      summary: {
        objects: Data.OBJECTS.length,
        journalEntries: s.journal.length,
        movements: s.movements.length,
        deposits: s.movements.filter(function (m) { return m.kind === 'deposit'; }).length
      },
      state: s
    };
  }

  function exportJSON(pretty) {
    return JSON.stringify(exportPayload(), null, pretty === false ? 0 : 2);
  }

  function backupFilename(ext) {
    var d = new Date();
    var stamp = d.getFullYear() + U.pad2(d.getMonth() + 1) + U.pad2(d.getDate()) + '-' +
      U.pad2(d.getHours()) + U.pad2(d.getMinutes());
    return 'zhkx-backup-' + stamp + (ext || '.json');
  }

  /**
   * Импорт резервной копии.
   * @param {string|object} input JSON-строка либо объект
   * @param {object} opts { mode: 'replace' | 'merge' }
   */
  function importJSON(input, opts) {
    var o = opts || {};
    var parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (!parsed) throw new Error('Файл пуст или не является JSON.');

    var incomingState = parsed.state || parsed;
    if (!incomingState || typeof incomingState !== 'object') throw new Error('В файле нет данных состояния.');
    if (!Array.isArray(incomingState.journal)) throw new Error('Файл повреждён: отсутствует журнал начислений.');

    var normalized = normalizeState(incomingState);

    if (o.mode === 'merge') {
      var s = get();
      var seenEntries = s.journal.reduce(function (acc, e) {
        acc[e.objectId + '|' + e.serviceId + '|' + e.period] = e; return acc;
      }, {});
      var added = 0, skipped = 0;
      normalized.journal.forEach(function (e) {
        var key = e.objectId + '|' + e.serviceId + '|' + e.period;
        if (seenEntries[key]) { skipped++; return; }
        s.journal.push(e);
        seenEntries[key] = e;
        added++;
      });
      var seenMov = s.movements.reduce(function (acc, m) { acc[m.id] = true; return acc; }, {});
      normalized.movements.forEach(function (m) {
        if (seenMov[m.id]) return;
        if (m.kind === 'charge' && !s.journal.filter(function (e) { return e.id === m.entryId; }).length) return;
        if (m.kind === 'charge') { /* движение к уже существующей записи — пропускаем дубль */ }
        else { s.movements.push(m); }
      });
      /* пересобираем движения-начисления для вновь добавленных записей */
      var chargeIds = s.movements.filter(function (m) { return m.kind === 'charge'; })
        .reduce(function (acc, m) { acc[m.entryId] = true; return acc; }, {});
      s.journal.forEach(function (e) {
        if (chargeIds[e.id]) return;
        addMovement({
          objectId: e.objectId, serviceId: e.serviceId, kind: 'charge',
          amount: -e.amount, date: e.date, period: e.period,
          note: 'Начисление ' + U.periodLabel(e.period), entryId: e.id
        });
      });
      Object.keys(normalized.objects).forEach(function (id) {
        s.objects[id] = s.objects[id] || normalized.objects[id];
      });
      Object.keys(normalized.meterSnapshots).forEach(function (id) {
        s.meterSnapshots[id] = Object.assign({}, s.meterSnapshots[id] || {}, normalized.meterSnapshots[id]);
      });
      recordOp('replace-state', { state: snapshotForServer(), reason: 'import-merge' });
      save();
      return { ok: true, mode: 'merge', added: added, skipped: skipped, journal: s.journal.length };
    }

    state = normalized;
    state.meta.importedAt = new Date().toISOString();
    recordOp('replace-state', { state: snapshotForServer(), reason: 'import' });
    save();
    return { ok: true, mode: 'replace', journal: state.journal.length, movements: state.movements.length };
  }

  function resetState() {
    state = createState();
    recordOp('replace-state', { state: snapshotForServer(), reason: 'reset' });
    save();
    return state;
  }

  /* ====================================== СИНХРОНИЗАЦИЯ С СЕРВЕРОМ ======= */
  /**
   * Локальное применение операций (те же правила, что на сервере: LWW +
   * надгробия). Нужно, чтобы показать пользователю его неотправленные правки
   * поверх только что полученного состояния сервера.
   */
  function applyOpsLocally(doc, ops) {
    (ops || []).forEach(function (op) {
      var at = op.at || new Date().toISOString();
      var p = op.payload || {};
      if (op.type === 'upsert-entry') upsertLocal(doc.journal, Object.assign({}, p, { updatedAt: p.updatedAt || at }), 'entry', at);
      else if (op.type === 'delete-entry') deleteLocal(doc, 'journal', p.id, 'entry', at);
      else if (op.type === 'upsert-movement') upsertLocal(doc.movements, Object.assign({}, p, { updatedAt: p.updatedAt || at }), 'movement', at);
      else if (op.type === 'delete-movement') deleteLocal(doc, 'movements', p.id, 'movement', at);
      else if (op.type === 'set-object') {
        var cur = doc.objects[p.objectId] || { overrides: { area: null, services: {} }, waterSchedule: null, notes: null };
        doc.objects[p.objectId] = Object.assign({}, cur, p.patch || {}, { _updatedAt: at });
      } else if (op.type === 'set-settings') {
        doc.settings = Object.assign({}, doc.settings, p.patch || {}, { _updatedAt: at });
      } else if (op.type === 'set-snapshot') {
        var bucket = doc.meterSnapshots[p.objectId] = doc.meterSnapshots[p.objectId] || {};
        bucket[p.serviceId] = Object.assign({}, bucket[p.serviceId] || {}, p.patch || {}, { _updatedAt: at });
      }
    });
    return doc;

    function upsertLocal(collection, entity, kind, stamp) {
      if (isBuriedIn(doc, kind, entity.id, stamp)) return;
      var idx = collection.findIndex(function (x) { return x.id === entity.id; });
      if (idx === -1) collection.push(entity);
      else collection[idx] = entity;
    }
    function deleteLocal(target, collection, id, kind, stamp) {
      doc.tombstones[kind + ':' + id] = stamp;
      target[collection] = target[collection].filter(function (x) { return x.id !== id; });
      if (kind === 'entry') {
        target.movements = target.movements.filter(function (m) { return !(m.kind === 'charge' && m.entryId === id); });
      }
    }
    function isBuriedIn(target, kind, id, stamp) {
      var t = target.tombstones[kind + ':' + id];
      return !!t && t >= String(stamp);
    }
  }

  /**
   * Принять состояние с сервера: сервер — источник правды, но неотправленные
   * локальные операции накладываются сверху, чтобы правки не «пропадали».
   */
  function applyServerState(serverState, options) {
    var o = options || {};
    if (!serverState) return get();
    var incoming = normalizeState(serverState);
    var pending = o.keepPending === false ? [] : get().outbox.slice();

    var merged = {
      meta: incoming.meta,
      settings: incoming.settings,
      objects: incoming.objects,
      movements: incoming.movements,
      journal: incoming.journal,
      meterSnapshots: incoming.meterSnapshots,
      tombstones: Object.assign({}, incoming.tombstones),
      outbox: pending
    };
    if (pending.length) applyOpsLocally(merged, pending);

    state = normalizeState(merged);
    state.outbox = pending;
    save();
    return state;
  }

  /** Ревизия, на которой основана локальная копия */
  function revision() { return Number(get().meta.revision || 0); }

  function setRevision(rev, updatedAt) {
    var s = get();
    s.meta.revision = Number(rev || 0);
    if (updatedAt) s.meta.serverUpdatedAt = updatedAt;
  }

  /* ================================================= ПРИМЕРНЫЕ ДАННЫЕ ===== */
  /**
   * Демо-наполнение: 12 месяцев истории по всем объектам, показания счётчиков,
   * крупные авансы (в т.ч. 5 000 ₽ на капремонт кв. 102 — пример из ТЗ).
   * Детерминированный псевдослучайный генератор → одинаковый результат.
   */
  function seedDemo(opts) {
    var o = opts || {};
    if (o.reset !== false) state = createState();
    var s = get();
    opSuppressed++;
    var seed = 20260101;
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    function pick(base, spread) { return base + Math.round((rnd() - 0.5) * spread); }

    var currentPeriod = U.currentPeriod();
    var monthsBack = U.toNumber(o.months, 12);
    var periods = [];
    for (var i = monthsBack; i >= 1; i--) periods.push(U.addMonths(currentPeriod, -i));

    var SERVICE_ORDER = ['maintenance', 'caprepair', 'internet', 'electricity', 'water'];

    Data.OBJECTS.forEach(function (baseObj) {
      var eff = effectiveObject(baseObj.id);
      var readings = blankReadings('electricity', eff.services.electricity.zones);
      /* стартовые показания — «жизненные» значения */
      if (readings.day !== undefined) {
        readings.day = pick(8000, 4000);
        readings.night = pick(3000, 2000);
      } else {
        readings.total = pick(9000, 6000);
      }
      var waterReadings = { total: pick(120, 60) };

      periods.forEach(function (period) {
        SERVICE_ORDER.forEach(function (serviceId) {
          var svc = eff.services[serviceId];
          if (!svc || svc.enabled === false) return;
          if (serviceId === 'internet' && !(svc.rate > 0)) return;
          /* По объектам с реальным архивом водомера вода берётся из архива ниже */
          if (serviceId === 'water' && (eff.services.water.archive || []).length) return;

          var payload = {
            objectId: eff.id,
            serviceId: serviceId,
            period: period,
            date: U.periodEndISO(period),
            origin: 'demo',
            note: 'Демо-данные'
          };

          if (serviceId === 'electricity') {
            var zoneCount = U.toNumber(eff.services.electricity.zones, 1);
            var prev = Object.assign({}, readings);
            if (zoneCount >= 2) {
              readings.day += pick(140, 90);
              readings.night += pick(110, 80);
            } else {
              readings.total += pick(230, 200);
            }
            payload.readings = Object.assign({}, readings);
            payload.previousReadings = prev;
            payload.previousPeriod = U.addMonths(period, -1);
            var bill = Engine.electricityBill(eff, payload.readings, prev);
            payload.amount = bill.total;
            payload.consumption = bill.consumption;
            payload.breakdown = bill;
            payload.amountSource = 'auto';
          } else if (serviceId === 'water') {
            var prevW = Object.assign({}, waterReadings);
            waterReadings.total += pick(7, 8);
            payload.readings = Object.assign({}, waterReadings);
            payload.previousReadings = prevW;
            payload.rateKey = svc.rateKey;
            payload.rate = Data.WATER_TARIFFS[svc.rateKey].rate;
            var w = Engine.waterBill(waterReadings.total - prevW.total, svc.rateKey);
            payload.amount = w.total;
            payload.consumption = w.volume;
            payload.amountSource = 'auto';
          } else {
            var ch = Engine.charge(eff, serviceId, {});
            payload.amount = ch.total;
            payload.rate = serviceId === 'internet' ? svc.rate : svc.rate;
            payload.amountSource = 'auto';
          }

          addEntry(payload, { silent: true });
        });
      });
    });

    /* --- Реальная история водомеров: переносим архивы из data-слоя в журнал ---- */
    Data.OBJECTS.forEach(function (baseObj) {
      if (!(baseObj.services.water.archive || []).length) return;
      importWaterArchive(baseObj.id, { includeZero: false });
    });

    /* --- Оплата прошедших периодов: закрываем все месяцы, кроме двух последних,
           чтобы демонстрационная картина содержала и текущий долг, и авансы. --- */
    var seededJournal = s.journal.slice();
    Data.OBJECTS.forEach(function (baseObj) {
      SERVICE_ORDER.forEach(function (serviceId) {
        var list = seededJournal
          .filter(function (e) { return e.objectId === baseObj.id && e.serviceId === serviceId; })
          .sort(function (a, b) { return a.period.localeCompare(b.period); });
        if (list.length <= 2) return;
        var covered = list.slice(0, list.length - 2);
        var paid = covered.reduce(function (acc, e) { return acc + e.amount; }, 0);
        if (!(paid > 0)) return;
        addMovement({
          objectId: baseObj.id, serviceId: serviceId, kind: 'payment',
          amount: U.round(paid, 2), date: covered[covered.length - 1].date,
          period: covered[covered.length - 1].period,
          note: 'Оплата квитанций за прошедшие периоды'
        });
      });
    });

    /* --- Крупные авансы (депозитные кошельки) ---------------------------------- */
    var depositPlan = [
      { obj: 'obj-01', svc: 'caprepair', amount: 24000, date: U.addMonths(currentPeriod, -10) + '-05', note: 'Крупный аванс на капремонт' },
      { obj: 'obj-01', svc: 'maintenance', amount: 6000, date: U.addMonths(currentPeriod, -6) + '-11', note: 'Аванс на содержание' },
      { obj: 'obj-02', svc: 'caprepair', amount: 15000, date: U.addMonths(currentPeriod, -9) + '-08', note: 'Крупный аванс на капремонт' },
      { obj: 'obj-03', svc: 'water', amount: 3000, date: U.addMonths(currentPeriod, -5) + '-15', note: 'Аванс за воду' },
      { obj: 'obj-03', svc: 'caprepair', amount: 8000, date: U.addMonths(currentPeriod, -7) + '-03', note: 'Аванс на капремонт' },
      /* эталонный пример ТЗ: 5 000 ₽ аванса на капремонт кв. 102 */
      { obj: 'obj-04', svc: 'caprepair', amount: 5000, date: U.addMonths(currentPeriod, -4) + '-19', note: 'Крупный аванс на капремонт (пример из ТЗ)' },
      { obj: 'obj-04', svc: 'maintenance', amount: 4200, date: U.addMonths(currentPeriod, -3) + '-07', note: 'Аванс на содержание' },
      { obj: 'obj-05', svc: 'caprepair', amount: 6000, date: U.addMonths(currentPeriod, -8) + '-21', note: 'Крупный аванс на капремонт' },
      { obj: 'obj-05', svc: 'internet', amount: 1800, date: U.addMonths(currentPeriod, -3) + '-02', note: 'Аванс за интернет (3 мес.)' },
      { obj: 'obj-06', svc: 'electricity', amount: 12000, date: U.addMonths(currentPeriod, -11) + '-14', note: 'Аванс за электроэнергию (дом)' },
      { obj: 'obj-06', svc: 'internet', amount: 2250, date: U.addMonths(currentPeriod, -4) + '-09', note: 'Аванс за интернет (3 мес.)' },
      { obj: 'obj-02', svc: 'internet', amount: 1800, date: U.addMonths(currentPeriod, -3) + '-06', note: 'Аванс за интернет (3 мес.)' }
    ];
    depositPlan.forEach(function (d) {
      addMovement({
        objectId: d.obj, serviceId: d.svc, kind: 'deposit',
        amount: d.amount, date: d.date, note: d.note,
        period: U.periodOfDate(d.date)
      });
    });

    /* --- Оплаты прошлых периодов, чтобы сальдо выглядело реалистично ---------- */
    ['obj-01', 'obj-02'].forEach(function (objId) {
      addMovement({
        objectId: objId, serviceId: 'electricity', kind: 'payment',
        amount: 9000, date: U.addMonths(currentPeriod, -11) + '-25',
        note: 'Перенос сальдо на начало учёта', period: U.addMonths(currentPeriod, -11)
      });
    });

    /* Открываем последний закрытый месяц — тот, по которому уже есть начисления */
    s.settings.activePeriod = periods.length ? periods[periods.length - 1] : currentPeriod;
    s.settings.activeObjectId = o.activateObjectId || Data.OBJECTS[0].id;

    opSuppressed--;
    /* На сервер уходит одним действием «полная замена» */
    recordOp('replace-state', { state: snapshotForServer(), reason: 'seed-demo' });
    save();
    return {
      ok: true,
      objects: Data.OBJECTS.length,
      periods: periods.length,
      entries: s.journal.length,
      movements: s.movements.length,
      archiveEntries: s.journal.filter(function (e) { return e.origin === 'archive'; }).length
    };
  }

  function hasAnyData() {
    var s = get();
    return s.journal.length > 0 || s.movements.length > 0;
  }

  /* ==================================================== НАСТРОЙКИ ======= */
  function setSetting(key, value) {
    get().settings[key] = value;
    var patch = {};
    patch[key] = value;
    recordOp('set-settings', { patch: patch });
    save();
    return value;
  }

  function getSetting(key, fallback) {
    var v = get().settings[key];
    return (v === undefined || v === null) ? fallback : v;
  }

  function activePeriod() {
    return getSetting('activePeriod', null) || U.currentPeriod();
  }

  function activeObjectId() {
    var id = getSetting('activeObjectId', null);
    var exists = Data.OBJECTS.some(function (o) { return o.id === id; });
    return exists ? id : Data.OBJECTS[0].id;
  }

  var State = {
    MOVEMENT_KINDS: MOVEMENT_KINDS,
    // синхронизация
    recordOp: recordOp,
    pendingOps: pendingOps,
    pendingCount: pendingCount,
    clearOps: clearOps,
    snapshotForServer: snapshotForServer,
    applyServerState: applyServerState,
    applyOpsLocally: applyOpsLocally,
    revision: revision,
    setRevision: setRevision,
    suppressOps: suppressOps,
    bury: bury,
    isBuried: isBuried,
    // хранилище
    load: load, get: get, save: save, reset: resetState, onSave: onSave,
    isStorageAvailable: function () { return storageAvailable; },
    hasAnyData: hasAnyData,
    // объекты
    effectiveObject: effectiveObject,
    effectiveObjects: effectiveObjects,
    setServiceOverride: setServiceOverride,
    setAreaOverride: setAreaOverride,
    resetOverrides: resetOverrides,
    hasOverrides: hasOverrides,
    // график тарифов воды (селектор периодов)
    waterSchedule: waterSchedule,
    setWaterSchedule: setWaterSchedule,
    addWaterScheduleRow: addWaterScheduleRow,
    removeWaterScheduleRow: removeWaterScheduleRow,
    resetWaterSchedule: resetWaterSchedule,
    isScheduleCustomized: isScheduleCustomized,
    // архив водомера
    waterArchiveInfo: waterArchiveInfo,
    importWaterArchive: importWaterArchive,
    // кошелёк
    movementsOf: movementsOf,
    balance: balance,
    balances: balances,
    advanceBalance: advanceBalance,
    debtBalance: debtBalance,
    coverageMap: coverageMap,
    wallet: wallet,
    addMovement: addMovement,
    addDeposit: addDeposit,
    addPayment: addPayment,
    addCorrection: addCorrection,
    removeMovement: removeMovement,
    // журнал
    addEntry: addEntry,
    updateEntry: updateEntry,
    removeEntry: removeEntry,
    entries: entries,
    findEntry: findEntry,
    lastEntry: lastEntry,
    // показания
    setMeterSnapshot: setMeterSnapshot,
    getMeterSnapshot: getMeterSnapshot,
    meterState: meterState,
    setMeterReading: setMeterReading,
    blankReadings: blankReadings,
    // экспорт/импорт
    exportPayload: exportPayload,
    exportJSON: exportJSON,
    backupFilename: backupFilename,
    importJSON: importJSON,
    seedDemo: seedDemo,
    // настройки
    setSetting: setSetting,
    getSetting: getSetting,
    activePeriod: activePeriod,
    activeObjectId: activeObjectId
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.State = State;
  if (typeof module !== 'undefined' && module.exports) module.exports = State;
})(typeof window !== 'undefined' ? window : globalThis);
