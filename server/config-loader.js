/* ============================================================================
 *  server/config-loader.js — ЧТЕНИЕ СПРАВОЧНИКОВ (data-слой) НА СЕРВЕРЕ
 *  ---------------------------------------------------------------------------
 *  Файл assets/js/data/config.js — обычный скрипт, написанный в браузерном
 *  стиле (window.ZHKX.Data = …). Чтобы получить данные на сервере, выполняем
 *  его в изолированном контексте Node (node:vm) без доступа к require,
 *  процессу, файловой системе и сети. Файл принадлежит проекту (не пользователю),
 *  поэтому такой запуск безопасен, а результат кэшируется по mtime.
 *
 *  Возможности:
 *    • objects()  — реестр объектов (площади, тарифы, счётчики, госповерка);
 *    • tariffs()  — сетки электроэнергии и тарифы воды;
 *    • meters()   — приборы учёта с расчётом даты следующей поверки;
 *    • validate() — проверка data-слоя (та же, что в браузере);
 *    • status()   — что загружено и когда файл менялся.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONFIG_FILE = path.join(__dirname, '..', 'assets', 'js', 'data', 'config.js');
let cache = { mtimeMs: 0, Data: null, loadedAt: null };

function load() {
  const stat = fs.statSync(CONFIG_FILE);
  if (cache.Data && cache.mtimeMs === stat.mtimeMs) return cache.Data;

  const code = fs.readFileSync(CONFIG_FILE, 'utf8');
  const sandbox = {
    window: {},
    module: { exports: {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'assets/js/data/config.js', timeout: 5000 });

  const Data = sandbox.window.ZHKX && sandbox.window.ZHKX.Data;
  if (!Data) throw new Error('config.js не экспортировал window.ZHKX.Data');
  cache = { mtimeMs: stat.mtimeMs, Data, loadedAt: new Date().toISOString(), mtime: stat.mtime.toISOString() };
  return Data;
}

function status() {
  const stat = fs.statSync(CONFIG_FILE);
  const data = load();
  return {
    file: 'assets/js/data/config.js',
    mtime: stat.mtime.toISOString(),
    size: stat.size,
    loadedAt: cache.loadedAt,
    app: { id: data.APP.id, version: data.APP.version, schemaVersion: data.APP.schemaVersion },
    objects: data.OBJECTS.length,
    services: data.SERVICES.length,
    electricityTariffs: Object.keys(data.ELECTRICITY_TARIFFS),
    waterTariffs: Object.keys(data.WATER_TARIFFS),
    waterScheduleDefault: data.WATER_TARIFF_SCHEDULE_DEFAULT,
    archiveRecords: data.OBJECTS.reduce(function (acc, o) {
      return acc + ((o.services.water.archive || []).length);
    }, 0)
  };
}

/** Реестр объектов в компактном виде (для API и напоминаний) */
function objects() {
  const Data = load();
  return Data.OBJECTS.map(function (o) {
    return {
      id: o.id,
      index: o.index,
      label: o.label,
      account: o.account,
      els: o.els,
      address: o.address.full,
      city: o.address.city,
      owner: o.owner,
      area: o.area,
      management: o.management,
      services: {
        maintenanceRate: o.services.maintenance.rate,
        capRepairRate: o.services.caprepair.rate,
        internetRate: o.services.internet.rate,
        internetEnabled: o.services.internet.enabled !== false,
        electricity: {
          account: o.account,
          category: o.services.electricity.category,
          zones: o.services.electricity.zones,
          meter: o.services.electricity.meter
        },
        water: {
          account: o.services.water.account || null,
          accountNote: o.services.water.accountNote || null,
          archive: (o.services.water.archive || []).length
        }
      },
      capRepairMonthly: Math.round(o.area * o.services.caprepair.rate * 100) / 100,
      maintenanceMonthly: Math.round(o.area * o.services.maintenance.rate * 100) / 100
    };
  });
}

function tariffs() {
  const Data = load();
  return {
    electricity: Data.ELECTRICITY_TARIFFS,
    water: Data.WATER_TARIFFS,
    waterOrder: Data.WATER_TARIFF_ORDER,
    waterDefault: Data.WATER_DEFAULT_RATE_KEY,
    waterScheduleDefault: Data.WATER_TARIFF_SCHEDULE_DEFAULT,
    rules: Data.RULES
  };
}

function meters() {
  const Data = load();
  const rows = [];
  Data.OBJECTS.forEach(function (o) {
    ['electricity', 'water'].forEach(function (serviceId) {
      const svc = o.services[serviceId];
      const m = (svc && svc.meter) || {};
      let nextCheckDate = null;
      let daysLeft = null;
      if (m.lastCheckDate && m.checkPeriodYears) {
        const d = new Date(m.lastCheckDate + 'T00:00:00Z');
        d.setUTCFullYear(d.getUTCFullYear() + Number(m.checkPeriodYears));
        nextCheckDate = d.toISOString().slice(0, 10);
        daysLeft = Math.round((d - new Date()) / 86400000);
      }
      rows.push({
        objectId: o.id,
        objectIndex: o.index,
        objectLabel: o.label,
        address: o.address.full,
        serviceId: serviceId,
        serial: m.serial || null,
        model: m.model || null,
        lastCheckDate: m.lastCheckDate || null,
        checkPeriodYears: m.checkPeriodYears || null,
        nextCheckDate: nextCheckDate,
        daysLeft: daysLeft,
        status: daysLeft === null ? 'unknown' : (daysLeft < 0 ? 'expired' : (daysLeft < 30 ? 'warning' : 'ok'))
      });
    });
  });
  return rows;
}

function validate() {
  return load().validate();
}

module.exports = { CONFIG_FILE, load, status, objects, tariffs, meters, validate };
