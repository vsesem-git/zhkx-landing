/* ============================================================================
 *  server/store.js — ХРАНИЛИЩЕ ДАННЫХ НА СЕРВЕРЕ В ВИДЕ .js-ФАЙЛА
 *  ---------------------------------------------------------------------------
 *  Данные пользователя (журнал начислений, движения кошельков, показания ПУ,
 *  правки тарифов и настроек) лежат в одном файле:
 *
 *      data/state.js   ←   window.ZHKX.StateData = { … };
 *
 *  Почему .js, а не .json:
 *    • файл отдаётся браузеру как обычный скрипт (без CORS и async);
 *    • его удобно читать глазами и сравнивать в diff;
 *    • сервер читает данные БЕЗ eval/require — извлекает JSON-литерал по
 *      маркерам и разбирает через JSON.parse (см. parse()).
 *
 *  Надёжность:
 *    • запись атомарная: временный файл → fs.renameSync;
 *    • каждая запись создаёт ревизию в data/history/state-<rev>-<ts>.js;
 *    • в шапке файла — revision, updatedAt и sha256-контрольная сумма;
 *    • все операции сериализуются мьютексом (очередь обещаний).
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = 'window.ZHKX.StateData = ';
/* Каталог данных можно переопределить (тесты, несколько инстансов):
   ZHKX_DATA_DIR=/tmp/zhkx-test node server/index.js */
const DATA_DIR = process.env.ZHKX_DATA_DIR
  ? path.resolve(process.env.ZHKX_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const STATE_FILE = path.join(DATA_DIR, 'state.js');
const TMP_FILE = path.join(DATA_DIR, '.state.tmp.js');

/* Сколько ревизий храним (остальные удаляются от старых к новым) */
const HISTORY_LIMIT = Number(process.env.ZHKX_HISTORY_LIMIT || 60);

/* ------------------------------------------------------------------ утилиты */
function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function isoNow() {
  return new Date().toISOString();
}

function pad(n, w) {
  return String(n).padStart(w || 2, '0');
}

function stamp(date) {
  const d = date || new Date();
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/** sha256 по данным (стабильный порядок ключей JSON.stringify(JSON.parse)) */
function checksum(data) {
  const canonical = JSON.stringify(data);
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

/* ------------------------------------------------- разбор и сериализация .js */
function serialize(data) {
  const json = JSON.stringify(data, null, 2);
  const rev = (data.meta && data.meta.revision) || 0;
  const updated = (data.meta && data.meta.updatedAt) || isoNow();
  const sum = checksum(data);
  return [
    '/* ============================================================================',
    ' *  data/state.js — ЖУРНАЛ НАЧИСЛЕНИЙ, АВАНСОВЫЕ КОШЕЛЬКИ И ПОКАЗАНИЯ ПУ',
    ' *  ----------------------------------------------------------------------------',
    ' *  Файл создаётся и перезаписывается автоматически сервером (server/store.js).',
    ' *  Руками править не нужно: при следующем сохранении изменения будут потеряны.',
    ' *  Для правки используйте интерфейс приложения или server/cli.js.',
    ' *',
    ' *  revision  : ' + rev,
    ' *  updatedAt : ' + updated,
    ' *  checksum  : ' + sum,
    ' * ==========================================================================*/',
    'window.ZHKX = window.ZHKX || {};',
    MARKER + json + ';',
    "if (typeof module !== 'undefined' && module.exports) module.exports = window.ZHKX.StateData;",
    ''
  ].join('\n');
}

/**
 * Извлекает объект состояния из .js-файла без исполнения кода.
 * Поиск «сбалансированного» JSON-объекта с учётом строк и экранирования.
 */
function parse(text) {
  const markerAt = text.indexOf(MARKER);
  if (markerAt === -1) throw new Error('Не найден маркер ' + MARKER + ' в data/state.js');
  const start = text.indexOf('{', markerAt);
  if (start === -1) throw new Error('Не найден объект состояния в data/state.js');

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error('Объект состояния не закрыт в data/state.js');
  return JSON.parse(text.slice(start, end));
}

/* --------------------------------------------- пустое состояние и нормализация */
function emptyState() {
  return {
    meta: { appId: 'zhkx-crimea', schemaVersion: 1, revision: 0, createdAt: isoNow(), updatedAt: isoNow() },
    settings: { activePeriod: null, activeObjectId: null, waterRateKey: 'actual_4796', theme: 'dark', _updatedAt: isoNow() },
    objects: {},
    movements: [],
    journal: [],
    meterSnapshots: {},
    tombstones: {}
  };
}

function normalize(data) {
  const d = data && typeof data === 'object' ? data : emptyState();
  d.meta = Object.assign(emptyState().meta, d.meta || {});
  d.settings = d.settings || {};
  d.objects = d.objects || {};
  d.movements = Array.isArray(d.movements) ? d.movements : [];
  d.journal = Array.isArray(d.journal) ? d.journal : [];
  d.meterSnapshots = d.meterSnapshots && typeof d.meterSnapshots === 'object' ? d.meterSnapshots : {};
  d.tombstones = d.tombstones && typeof d.tombstones === 'object' ? d.tombstones : {};
  /* служебное поле клиента — на сервере не храним */
  delete d.outbox;
  return d;
}

/* ------------------------------------------------------------- мьютекс записи */
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ загрузка */
function load() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    const fresh = emptyState();
    writeAtomic(serialize(fresh));
    return { data: fresh, file: STATE_FILE, exists: false };
  }
  const text = fs.readFileSync(STATE_FILE, 'utf8');
  let data;
  try {
    data = normalize(parse(text));
  } catch (e) {
    /* Битый файл: сохраняем как есть для разбора и поднимаем чистую копию */
    const broken = STATE_FILE + '.broken-' + stamp();
    fs.copyFileSync(STATE_FILE, broken);
    throw Object.assign(new Error('data/state.js повреждён: ' + e.message + ' (копия: ' + path.basename(broken) + ')'), { code: 'BROKEN_STATE' });
  }
  return { data, file: STATE_FILE, exists: true, checksum: checksum(data) };
}

function writeAtomic(text) {
  ensureDirs();
  fs.writeFileSync(TMP_FILE, text, 'utf8');
  fs.renameSync(TMP_FILE, STATE_FILE);
}

/** Сохраняет состояние, поднимает ревизию, пишет историю и подчищает старые */
function persist(data, options) {
  const o = options || {};
  const next = normalize(data);
  next.meta.revision = Number(next.meta.revision || 0) + 1;
  next.meta.updatedAt = isoNow();
  delete next.meta.restoredFrom;

  const text = serialize(next);
  writeAtomic(text);

  const historyName = 'state-' + String(next.meta.revision).padStart(5, '0') + '-' + stamp() + '.js';
  fs.writeFileSync(path.join(HISTORY_DIR, historyName), text, 'utf8');
  pruneHistory();

  return {
    data: next,
    revision: next.meta.revision,
    updatedAt: next.meta.updatedAt,
    checksum: checksum(next),
    historyFile: historyName,
    reason: o.reason || 'save',
    actor: o.actor || 'system'
  };
}

function pruneHistory() {
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => /^state-\d+.*\.js$/.test(f)).sort();
  while (files.length > HISTORY_LIMIT) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(HISTORY_DIR, old)); } catch (e) { /* ignore */ }
  }
  return files;
}

function revisions(limit) {
  ensureDirs();
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => /^state-\d+.*\.js$/.test(f)).sort().reverse();
  const list = files.slice(0, limit || 50).map((name) => {
    const full = path.join(HISTORY_DIR, name);
    const st = fs.statSync(full);
    let meta = {};
    try {
      const data = parse(fs.readFileSync(full, 'utf8'));
      meta = { revision: data.meta.revision, updatedAt: data.meta.updatedAt, journal: data.journal.length, movements: data.movements.length };
    } catch (e) { meta = { error: e.message }; }
    return Object.assign({ file: name, size: st.size, mtime: st.mtime.toISOString() }, meta);
  });
  return list;
}

function readRevision(name) {
  const safe = path.basename(String(name));
  const full = path.join(HISTORY_DIR, safe);
  if (!fs.existsSync(full)) throw Object.assign(new Error('Ревизия не найдена: ' + safe), { code: 'NOT_FOUND' });
  return { file: safe, text: fs.readFileSync(full, 'utf8'), data: normalize(parse(fs.readFileSync(full, 'utf8'))) };
}

/* ==========================================================================
 *  ПРИМЕНЕНИЕ ОПЕРАЦИЙ КЛИЕНТА (идемпотентно, last-write-wins + надгробия)
 * ==========================================================================
 *  op = { id, type, payload, at }
 *    upsert-entry / delete-entry
 *    upsert-movement / delete-movement
 *    set-object      (правки площади, тарифов, ПУ, графика воды по объекту)
 *    set-settings
 *    set-snapshot    (текущие показания ПУ)
 *    replace-state   (импорт бэкапа, сброс, демо-наполнение)
 * ========================================================================== */
function applyOps(data, ops, options) {
  const o = options || {};
  const doc = normalize(JSON.parse(JSON.stringify(data)));
  const applied = [];
  const skipped = [];
  let changed = false;

  const tomb = doc.tombstones;
  function bury(key, at) {
    if (!tomb[key] || tomb[key] < at) tomb[key] = at;
  }
  function buried(key, at) {
    return !!tomb[key] && tomb[key] >= String(at || '');
  }

  function upsertEntity(collection, entity, kind, at) {
    const key = kind + ':' + entity.id;
    if (buried(key, at)) { skipped.push({ id: entity.id, reason: 'deleted-later', type: kind }); return; }
    const idx = doc[collection].findIndex((x) => x.id === entity.id);
    if (idx === -1) {
      doc[collection].push(entity);
      changed = true;
      applied.push({ id: entity.id, action: 'created', type: kind });
      return;
    }
    const current = doc[collection][idx];
    const currentAt = current.updatedAt || current.createdAt || '';
    if (String(at || '') < String(currentAt)) {
      skipped.push({ id: entity.id, reason: 'older', type: kind });
      return;
    }
    doc[collection][idx] = entity;
    changed = true;
    applied.push({ id: entity.id, action: 'updated', type: kind });
  }

  function removeEntity(collection, id, kind, at) {
    bury(kind + ':' + id, at);
    const before = doc[collection].length;
    doc[collection] = doc[collection].filter((x) => x.id !== id);
    if (kind === 'entry') {
      /* вместе с записью журнала убираем её движение-начисление */
      doc.movements = doc.movements.filter((m) => !(m.kind === 'charge' && m.entryId === id));
    }
    if (doc[collection].length !== before) {
      changed = true;
      applied.push({ id, action: 'deleted', type: kind });
    } else {
      applied.push({ id, action: 'delete-noop', type: kind });
    }
  }

  (ops || []).forEach((op, i) => {
    if (!op || !op.type) { skipped.push({ index: i, reason: 'malformed' }); return; }
    const at = op.at || isoNow();
    const p = op.payload || {};

    switch (op.type) {
      case 'upsert-entry':
        upsertEntity('journal', Object.assign({}, p, { updatedAt: at }), 'entry', at);
        break;
      case 'delete-entry':
        removeEntity('journal', p.id, 'entry', at);
        break;
      case 'upsert-movement':
        upsertEntity('movements', Object.assign({}, p, { updatedAt: at }), 'movement', at);
        break;
      case 'delete-movement':
        removeEntity('movements', p.id, 'movement', at);
        break;
      case 'set-object': {
        const key = 'object:' + p.objectId;
        if (buried(key, at)) { skipped.push({ id: p.objectId, reason: 'deleted-later', type: 'object' }); break; }
        const current = doc.objects[p.objectId] || { overrides: { area: null, services: {} }, waterSchedule: null, notes: null };
        const currentAt = current._updatedAt || '';
        if (String(at) < String(currentAt)) { skipped.push({ id: p.objectId, reason: 'older', type: 'object' }); break; }
        doc.objects[p.objectId] = Object.assign({}, current, p.patch || {}, { _updatedAt: at });
        changed = true;
        applied.push({ id: p.objectId, action: 'updated', type: 'object' });
        break;
      }
      case 'set-settings': {
        const currentAt = doc.settings._updatedAt || '';
        if (String(at) < String(currentAt)) { skipped.push({ id: 'settings', reason: 'older', type: 'settings' }); break; }
        doc.settings = Object.assign({}, doc.settings, p.patch || {}, { _updatedAt: at });
        changed = true;
        applied.push({ id: 'settings', action: 'updated', type: 'settings' });
        break;
      }
      case 'set-snapshot': {
        const bucket = doc.meterSnapshots[p.objectId] = doc.meterSnapshots[p.objectId] || {};
        const current = bucket[p.serviceId] || {};
        if (String(at) < String(current._updatedAt || '')) { skipped.push({ id: p.objectId + '/' + p.serviceId, reason: 'older', type: 'snapshot' }); break; }
        bucket[p.serviceId] = Object.assign({}, current, p.patch || {}, { _updatedAt: at });
        changed = true;
        applied.push({ id: p.objectId + '/' + p.serviceId, action: 'updated', type: 'snapshot' });
        break;
      }
      case 'replace-state': {
        /* Полная замена (импорт бэкапа, сброс, демо-данные) */
        const incoming = normalize(JSON.parse(JSON.stringify(p.state || {})));
        incoming.meta.revision = doc.meta.revision;
        incoming.meta.createdAt = doc.meta.createdAt;
        doc.settings = incoming.settings;
        doc.objects = incoming.objects;
        doc.movements = incoming.movements;
        doc.journal = incoming.journal;
        doc.meterSnapshots = incoming.meterSnapshots;
        doc.tombstones = incoming.tombstones || {};
        changed = true;
        applied.push({ id: 'state', action: 'replaced', type: 'state', journal: doc.journal.length });
        break;
      }
      default:
        skipped.push({ index: i, reason: 'unknown-type:' + op.type });
    }
  });

  return { data: doc, applied, skipped, changed };
}

/* ------------------------------------------------------------ экспорт/импорт */
function backupPayload(data, extra) {
  return {
    format: 'zhkx-crimea-server-backup',
    formatVersion: 1,
    exportedAt: isoNow(),
    server: extra || null,
    summary: {
      revision: (data.meta && data.meta.revision) || 0,
      journalEntries: data.journal.length,
      movements: data.movements.length,
      objects: Object.keys(data.objects).length
    },
    state: data
  };
}

module.exports = {
  MARKER,
  DATA_DIR,
  HISTORY_DIR,
  STATE_FILE,
  ensureDirs,
  load,
  persist,
  serialize,
  parse,
  normalize,
  emptyState,
  applyOps,
  revisions,
  readRevision,
  checksum,
  isoNow,
  stamp,
  backupPayload,
  withLock,
  pruneHistory
};
