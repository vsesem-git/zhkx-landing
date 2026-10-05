/* ============================================================================
 *  tools/servertest.mjs — интеграционные тесты сервера и синхронизации
 *  ---------------------------------------------------------------------------
 *  Запуск:  node tools/servertest.mjs        (или npm run test:server)
 *
 *  Тест поднимает НАСТОЯЩИЙ сервер на свободном порту с ИЗОЛИРОВАННЫМ каталогом
 *  данных (ZHKX_DATA_DIR=/tmp/zhkx-servertest-…), поэтому рабочие данные
 *  data/state.js не затрагиваются. Проверяются:
 *    • запуск, health, аутентификация по токену и файл data/auth.json;
 *    • REST API: состояние, ETag, операции, история ревизий, откат, импорт;
 *    • идемпотентность операций, разрешение конфликтов (LWW) и надгробия;
 *    • data/state.js как .js-файл: содержимое, парсинг, ревизии, персистентность
 *      после перезапуска сервера;
 *    • раздача статики и защита приватных путей;
 *    • сквозной сценарий: приложение (jsdom) подключается к серверу, забирает
 *      данные, сохраняет начисление и отправляет его на сервер.
 * ==========================================================================*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Свободный порт (можно зафиксировать: ZHKX_TEST_PORT=8123) */
let PORT = Number(process.env.ZHKX_TEST_PORT || (8100 + Math.floor(Math.random() * 800)));
let BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'demo-token';
/* Уникальный идентификатор нашего процесса: защищает тест от «чужого» сервера
   на том же порту (например, оставшегося от предыдущего запуска). */
const INSTANCE = 'servertest-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (e) { /* тест клиента пропустим */ }

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
function section(n) { console.log(`\n${BOLD}${n}${RESET}`); }
function check(label, actual, expected, tol = 0.005) {
  const ok = typeof expected === 'number' ? Math.abs(Number(actual) - expected) <= tol : actual === expected;
  if (ok) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}${typeof expected === 'number' ? DIM + ` → ${actual}` + RESET : ''}`); }
  else { failed++; console.log(`  ${RED}✗ ${label}${RESET}\n     ожидалось: ${JSON.stringify(expected)}\n     получено : ${JSON.stringify(actual)}`); }
}
function checkTrue(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}`); }
  else { failed++; console.log(`  ${RED}✗ ${label}${RESET} ${extra}`); }
}

/* ---------------------------------------------------------------- утилиты -- */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhkx-servertest-'));

async function request(pathname, options = {}) {
  const { token, body, headers = {}, method = body ? 'POST' : 'GET' } = options;
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Accept': 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token !== null && token !== undefined ? { 'Authorization': 'Bearer ' + token } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined

  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, headers: res.headers, json, text };
}

/** Сырой HTTP-запрос через сокет: позволяет отправить путь как есть */
async function rawRequest(pathAndQuery) {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write('GET ' + pathAndQuery + ' HTTP/1.1\r\nHost: 127.0.0.1:' + PORT + '\r\nConnection: close\r\n\r\n');
    });
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => {
      const status = Number((data.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0);
      const idx = data.indexOf('\r\n\r\n');
      resolve({ status, body: idx === -1 ? '' : data.slice(idx + 4) });
    });
    socket.on('error', reject);
  });
}

let serverProcess = null;
let serverLog = '';

async function startServer(env = {}, attempt = 0) {
  serverLog = '';
  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ZHKX_DATA_DIR: DATA_DIR,
      ZHKX_DEMO_AUTH: '1',
      ZHKX_HISTORY_LIMIT: '10',
      ZHKX_NOTIFY_DISABLED: '1',
      ZHKX_INSTANCE_ID: INSTANCE
    }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (d) => { serverLog += d.toString(); });
  serverProcess.stderr.on('data', (d) => { serverLog += d.toString(); });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (/EADDRINUSE/.test(serverLog)) {
      await stopServer();
      if (attempt < 3) {
        PORT = 8100 + Math.floor(Math.random() * 800);
        BASE = `http://127.0.0.1:${PORT}`;
        return startServer(env, attempt + 1);
      }
      throw new Error('Порт ' + PORT + ' занят. Лог:\n' + serverLog);
    }
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) {
        const json = await res.json();
        if (json.instance === INSTANCE) return serverLog;
        /* На порту чужой сервер (остался от прошлого запуска) — берём другой */
        await stopServer();
        if (attempt < 5) {
          PORT = 8100 + Math.floor(Math.random() * 800);
          BASE = `http://127.0.0.1:${PORT}`;
          return startServer(env, attempt + 1);
        }
      }
    } catch (e) { /* сервер ещё не слушает */ }
    await sleep(150);
  }
  throw new Error('Сервер не поднялся за 20 с. Лог:\n' + serverLog);
}

/** Дождаться появления текста в логе сервера (stdout приходит асинхронно) */
async function waitForLog(pattern, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(serverLog)) return true;
    await sleep(80);
  }
  return pattern.test(serverLog);
}

async function stopServer() {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && proc.exitCode === null && !proc.killed) await sleep(100);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

function stateFileText() {
  return fs.readFileSync(path.join(DATA_DIR, 'state.js'), 'utf8');
}

/* ========================================================================= */
section('1. Запуск сервера и health');
await startServer();
checkTrue('сервер слушает порт ' + PORT + ' (свой процесс)', true);
const health = await request('/api/health');
check('health: код ответа', health.status, 200);
checkTrue('health: ok = true', health.json.ok === true, JSON.stringify(health.json));
check('health: хранилище — .js-файл', health.json.app.storage, 'server-js');
check('health: файл состояния', health.json.app.stateFile, 'data/state.js');
check('health: начальная ревизия', health.json.revision, 0);
checkTrue('health: демо-аутентификация включена', health.json.auth.demoAuth === true, JSON.stringify(health.json.auth));
checkTrue('health: контрольная сумма файла присутствует', typeof health.json.checksum === 'string' && health.json.checksum.length >= 16, String(health.json.checksum));
checkTrue('баннер сервера выводит токен и адрес', await waitForLog(/demo-token/) && /localhost:\d+/.test(serverLog),
  serverLog.split('\n').slice(-8).join(' | '));
checkTrue('data/state.js создан на диске как .js-файл', fs.existsSync(path.join(DATA_DIR, 'state.js')));
const stateText0 = stateFileText();
checkTrue('state.js содержит window.ZHKX.StateData (данные в виде js)', stateText0.includes('StateData'), stateText0.slice(0, 120));
checkTrue('state.js содержит заголовок с ревизией', /revision/i.test(stateText0));

/* ========================================================================= */
section('2. Аутентификация по токену');
const noToken = await request('/api/state', { token: null });
check('без токена — 401', noToken.status, 401);
checkTrue('в ошибке сказано про авторизацию', /токен|авторизац|Authorization/i.test(noToken.json.error || ''), noToken.json.error);
const badToken = await request('/api/state', { token: 'bad-token-0123456789' });
check('неверный токен — 401', badToken.status, 401);
const loginBad = await request('/api/login', { body: { token: 'совсем-не-тот-токен' } });
check('login с неверным токеном — 401', loginBad.status, 401);
const loginOk = await request('/api/login', { body: { token: TOKEN } });
check('login с верным токеном — 200', loginOk.status, 200);
checkTrue('login подтвердил доступ', loginOk.json.ok === true);
const tokenRoute = await request('/api/token', { token: null });
check('GET /api/token с localhost доступен', tokenRoute.status, 200);
check('GET /api/token отдаёт демо-токен', tokenRoute.json.token, TOKEN);
checkTrue('GET /api/token сообщает о демо-режиме', tokenRoute.json.demoAuth === true);

section('2.1. Боевой режим: токен генерируется в data/auth.json');
await stopServer();
await startServer({ ZHKX_DEMO_AUTH: '', ZHKX_TOKEN: '' });
const authFile = path.join(DATA_DIR, 'auth.json');
let authMeta = null;
try { authMeta = fs.statSync(authFile); } catch (e) { authMeta = null; }
checkTrue('файл data/auth.json создан автоматически', !!authMeta, String(authMeta));
if (authMeta) check('права на data/auth.json (только владелец)', (authMeta.mode & 0o777).toString(8), '600');
const prodToken = JSON.parse(fs.readFileSync(authFile, 'utf8')).token;
checkTrue('токен сгенерирован (не пустой)', typeof prodToken === 'string' && prodToken.length >= 16, String(prodToken));
const prodTokenRoute = await request('/api/token', { token: null });
check('GET /api/token отдаёт сгенерированный токен', prodTokenRoute.json.token, prodToken);
checkTrue('демо-режим выключен', prodTokenRoute.json.demoAuth === false);
const demoInProd = await request('/api/login', { body: { token: TOKEN } });
check('в боевом режиме демо-токен не принимается', demoInProd.status, 401);
const prodLogin = await request('/api/login', { body: { token: prodToken } });
check('вход по сгенерированному токену — 200', prodLogin.status, 200);
checkTrue('health сообщает, что токен требуется', (await request('/api/health')).json.auth.demoAuth === false);

/* Возвращаемся в демо-режим для остальных проверок */
await stopServer();
await startServer();

/* ========================================================================= */
section('3. Состояние и ETag');
const st0 = await request('/api/state', { token: TOKEN });
check('GET /api/state — 200', st0.status, 200);
check('состояние: ревизия', st0.json.revision, 0);
check('состояние: пустой журнал', st0.json.state.journal.length, 0);
checkTrue('состояние содержит структуры разделов (objects/journal/settings/tombstones)',
  !!st0.json.state.tombstones && !!st0.json.state.settings && !!st0.json.state.objects && Array.isArray(st0.json.state.journal));
checkTrue('очередь операций — клиентская, на сервере не хранится', st0.json.state.outbox === undefined);
const etag = st0.headers.get('etag');
checkTrue('ETag отдан', !!etag, String(etag));
const st0b = await request('/api/state', { token: TOKEN, headers: { 'If-None-Match': etag } });
check('повторный запрос с If-None-Match → 304 (без тела)', st0b.status, 304);

/* ========================================================================= */
section('4. Операции клиента: создание, идемпотентность, конфликты');
/* Метки времени — относительно «сейчас»: сервер сравнивает их с временем
   создания файла состояния (LWW), поэтому абсолютные даты из прошлого не годятся. */
const iso = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const t1 = iso(60);      // первая правка
const t2 = iso(120);     // последующая правка того же поля
const t3 = iso(180);     // удаление
const t4 = iso(240);     // настройки
const tStale = iso(30);  // «устаревшая» правка (раньше t1)
const movement = {
  id: 'mv-test-1', objectId: 'obj-04', serviceId: 'caprepair', kind: 'deposit',
  amount: 5000, date: '2026-10-01', period: '2026-10', note: 'тест', createdAt: t1, updatedAt: t1
};
const entry = {
  id: 'en-test-1', objectId: 'obj-04', serviceId: 'caprepair', period: '2026-10',
  date: '2026-10-31', amount: 602.80, amountSource: 'auto', note: 'кв.102', createdAt: t1, updatedAt: t1
};
const ops1 = [
  { id: 'op-1', type: 'upsert-movement', payload: movement, at: t1 },
  { id: 'op-2', type: 'upsert-entry', payload: entry, at: t1 }
];
const ev1 = await request('/api/events', { token: TOKEN, body: { ops: ops1, baseRevision: 0, clientId: 'test' } });
check('POST /api/events — 200', ev1.status, 200);
check('ревизия выросла до 1', ev1.json.revision, 1);
check('применено операций', ev1.json.applied.length, 2);
check('пропущено операций', ev1.json.skipped.length, 0);
check('журнал на сервере: 1 запись', ev1.json.state.journal.length, 1);
check('движений на сервере: 1', ev1.json.state.movements.length, 1);
check('в истории появился файл ревизии 1', ev1.json.historyFile, 'state-00001-' + ev1.json.historyFile.split('-').slice(2).join('-'));
checkTrue('файл ревизии создан в data/history', fs.readdirSync(path.join(DATA_DIR, 'history')).some((f) => f.startsWith('state-00001')));

/* Повторная отправка тех же операций (клиент не успел очистить очередь) */
const ev1b = await request('/api/events', { token: TOKEN, body: { ops: ops1, baseRevision: 0, clientId: 'test' } });
check('повторная отправка не дублирует запись', ev1b.json.state.journal.length, 1);
check('повторная отправка не дублирует движение', ev1b.json.state.movements.length, 1);
checkTrue('конфликта нет (baseRevision = 0 — «первый раз») ', ev1b.json.conflict === null, JSON.stringify(ev1b.json.conflict));

/* Устаревшая правка: время операции раньше сохранённого updatedAt */
const stale = { id: 'en-test-1', objectId: 'obj-04', serviceId: 'caprepair', period: '2026-10', date: '2026-10-31', amount: 1, updatedAt: t1 };
const ev2 = await request('/api/events', {
  token: TOKEN,
  body: { ops: [{ id: 'op-3', type: 'upsert-entry', payload: stale, at: '2026-09-30T00:00:00.000Z' }], baseRevision: 1, clientId: 'test' }
});
checkTrue('устаревшая правка отброшена', ev2.json.skipped.some((s) => s.reason === 'older'), JSON.stringify(ev2.json.skipped));
check('сумма записи не изменилась', ev2.json.state.journal[0].amount, 602.80);

/* Свежая правка того же поля — LWW: применяем */
const fresh = Object.assign({}, entry, { amount: 650, updatedAt: t2 });
const ev3 = await request('/api/events', {
  token: TOKEN, body: { ops: [{ id: 'op-4', type: 'upsert-entry', payload: fresh, at: t2 }], baseRevision: ev2.json.revision, clientId: 'test' }
});
check('свежая правка применилась (last-write-wins)', ev3.json.state.journal[0].amount, 650);
checkTrue('конфликта нет, если baseRevision актуален', ev3.json.conflict === null, JSON.stringify(ev3.json.conflict));

/* Конфликт по ревизии: клиент отправил устаревшую базовую ревизию */
const ev4 = await request('/api/events', {
  token: TOKEN, body: { ops: [{ id: 'op-5', type: 'set-settings', payload: { patch: { theme: 'light' } }, at: t4 }], baseRevision: 1, clientId: 'test' }
});
checkTrue('сервер сообщил о конфликте ревизий', !!ev4.json.conflict, JSON.stringify(ev4.json.conflict));
check('правка применена (конфликт решается слиянием, а не отказом)', ev4.json.state.settings.theme, 'light');

/* Надгробие: удаление записи и последующая «воскрешающая» отправка */
const del = await request('/api/events', {
  token: TOKEN, body: { ops: [{ id: 'op-6', type: 'delete-entry', payload: { id: 'en-test-1' }, at: t3 }], baseRevision: ev4.json.revision, clientId: 'test' }
});
check('запись удалена', del.json.state.journal.length, 0);
checkTrue('движение-начисление удалено вместе с записью', !del.json.state.movements.some((m) => m.entryId === 'en-test-1'),
  JSON.stringify(del.json.state.movements.map((m) => m.id)));
checkTrue('надгробие сохранено в state.js', !!del.json.state.tombstones['entry:en-test-1']);
const resurrect = await request('/api/events', {
  token: TOKEN, body: { ops: [{ id: 'op-7', type: 'upsert-entry', payload: entry, at: t1 }], baseRevision: del.json.revision, clientId: 'test' }
});
checkTrue('старая правка не «воскресила» удалённую запись', resurrect.json.state.journal.length === 0,
  'journal=' + JSON.stringify(resurrect.json.state.journal.map((e) => e.id)) + ' applied=' + JSON.stringify(resurrect.json.applied) + ' skipped=' + JSON.stringify(resurrect.json.skipped) + ' tombstones=' + JSON.stringify(resurrect.json.state.tombstones));

/* ========================================================================= */
section('5. Справочники из data-слоя (config.js через vm)');
const config = await request('/api/config', { token: TOKEN });
check('объектов в реестре', config.json.objects.length, 6);
check('тарифных сеток электроэнергии', Object.keys(config.json.tariffs.electricity || {}).length, 3);
check('тарифы воды: 3 варианта', Object.keys(config.json.tariffs.water || {}).length, 3);
check('данные слоя валидны', config.json.validation.ok, true);
checkTrue('справочник приборов учёта не пуст', (config.json.meters || []).length >= 6, String((config.json.meters || []).length));

/* ========================================================================= */
section('6. Ревизии и откат');
const revs = await request('/api/revisions?limit=20', { token: TOKEN });
checkTrue('список ревизий не пуст', revs.json.revisions.length > 0, JSON.stringify(revs.json.revisions.length));
check('текущая ревизия совпадает с последней', revs.json.current, revs.json.revisions[0].revision);
const revFile = revs.json.revisions[revs.json.revisions.length - 1].file;
const revText = await request('/api/revisions/' + encodeURIComponent(revFile), { token: TOKEN });
checkTrue('ревизия отдаётся как текст .js-файла', revText.status === 200 && revText.text.includes('StateData'), String(revText.status));
const restoreTarget = revs.json.revisions.find((r) => r.revision === 1) || revs.json.revisions[revs.json.revisions.length - 1];
const restore = await request('/api/restore', { token: TOKEN, body: { file: restoreTarget.file, clientId: 'test' } });
check('откат прошёл', restore.status, 200);
check('после отката журнал как в ревизии 1', restore.json.state.journal.length, 1);
checkTrue('откат создал НОВУЮ ревизию (история не потеряна)', restore.json.revision > restoreTarget.revision,
  `было r${restoreTarget.revision}, стало r${restore.json.revision}`);
checkTrue('файл ревизии для отката записан', fs.readdirSync(path.join(DATA_DIR, 'history')).length >= 2);

/* ========================================================================= */
section('7. Экспорт, импорт, сброс');
const exp = await request('/api/export', { token: TOKEN });
check('экспорт — 200', exp.status, 200);
checkTrue('в экспорте есть данные и обвязка', !!exp.json.state && !!exp.json.exportedAt, Object.keys(exp.json).join(','));
const imported = await request('/api/import', {
  token: TOKEN,
  body: {
    state: {
      meta: { schemaVersion: 1, revision: 0 },
      settings: { theme: 'dark' },
      objects: {}, movements: [], journal: [
        { id: 'en-imp-1', objectId: 'obj-01', serviceId: 'maintenance', period: '2026-08', date: '2026-08-31', amount: 1925, updatedAt: t2 }
      ],
      meterSnapshots: {}, tombstones: {}, outbox: []
    },
    clientId: 'test'
  }
});
check('импорт — 200', imported.status, 200);
check('импорт заменил состояние (по сводке сервера)', imported.json.journal, 1);
const afterImport = await request('/api/state', { token: TOKEN });
check('импорт заменил состояние (по факту)', afterImport.json.state.journal.length, 1);
check('импорт вернул тему из бэкапа', afterImport.json.state.settings.theme, 'dark');
checkTrue('импорт создал новую ревизию', imported.json.revision > exp.json.summary.revision || imported.json.revision > 0,
  'r' + imported.json.revision + ' при экспорте r' + exp.json.summary.revision);
const reset = await request('/api/reset', { token: TOKEN, body: {} });
const afterReset = await request('/api/state', { token: TOKEN });
check('сброс очистил журнал', afterReset.json.state.journal.length, 0);

/* ========================================================================= */
section('8. Напоминания (госповерка, показания, долги)');
const reminders = await request('/api/reminders', { token: TOKEN });
check('GET /api/reminders — 200', reminders.status, 200);
checkTrue('пришёл массив напоминаний', Array.isArray(reminders.json.reminders), JSON.stringify(reminders.json).slice(0, 120));
checkTrue('у напоминаний есть уровни важности', reminders.json.reminders.every((r) => ['danger', 'warn', 'info', 'ok'].includes(r.level)));
checkTrue('текст для Telegram формируется', typeof reminders.json.preview === 'string' && reminders.json.preview.includes('ЖКУ'), String(reminders.json.preview).slice(0, 60));
const send = await request('/api/reminders/send', { token: TOKEN, body: {} });
checkTrue('POST /api/reminders/send не падает без настроенного Telegram', send.status === 200, JSON.stringify(send.json));

/* ========================================================================= */
section('9. Статика и защита путей');
const page = await fetch(BASE + '/');
check('GET / — 200', page.status, 200);
const pageHtml = await page.text();
checkTrue('отдана страница приложения', pageHtml.includes('ЖКУ · Крым'), pageHtml.slice(0, 80));
checkTrue('подключён клиент синхронизации', pageHtml.includes('core/sync.js'));
checkTrue('подключён манифест PWA', pageHtml.includes('manifest.webmanifest'));
const sw = await fetch(BASE + '/sw.js');
check('GET /sw.js — 200', sw.status, 200);
check('sw.js отдан как JavaScript', sw.headers.get('content-type'), 'application/javascript; charset=utf-8');
checkTrue('для sw.js разрешён scope «/»', sw.headers.get('service-worker-allowed') === '/', String(sw.headers.get('service-worker-allowed')));
const manifest = await fetch(BASE + '/manifest.webmanifest');
check('GET /manifest.webmanifest — 200', manifest.status, 200);
checkTrue('манифест — JSON с именем приложения', /ЖКУ/.test(await manifest.text()));
const syncJs = await fetch(BASE + '/assets/js/core/sync.js');
check('GET /assets/js/core/sync.js — 200', syncJs.status, 200);
const privateState = await fetch(BASE + '/data/state.js');
check('GET /data/state.js без токена — 401', privateState.status, 401);
const privateStateOk = await fetch(BASE + '/data/state.js?token=' + TOKEN);
check('GET /data/state.js?token=… — 200', privateStateOk.status, 200);
checkTrue('прямой доступ отдаёт содержимое state.js', (await privateStateOk.text()).includes('StateData'));
const privateServer = await fetch(BASE + '/server/store.js');
check('исходники сервера не раздаются (404)', privateServer.status, 404);
const privateData = await fetch(BASE + '/data/auth.json');
check('файл с токеном не раздаётся', privateData.status, 404);
/* Сырой HTTP-запрос: путь с «..» не нормализуется клиентом, как в fetch.
   Обход каталога не должен давать доступ ни к данным, ни к токену, ни к коду сервера. */
const traversal = await rawRequest('/assets/../data/state.js');
checkTrue('обход «/assets/../data/state.js» не отдаёт данные состояния без токена',
  !/StateData/.test(traversal.body), 'HTTP ' + traversal.status + ': ' + traversal.body.slice(0, 80));
const traversal2 = await rawRequest('/assets/..%2fdata%2fauth.json');
checkTrue('обход «/assets/..%2fdata%2fauth.json» не отдаёт файл с токеном',
  !/"token"/.test(traversal2.body), 'HTTP ' + traversal2.status + ': ' + traversal2.body.slice(0, 80));
const traversal3 = await rawRequest('/assets/../server/store.js');
checkTrue('обход «/assets/../server/store.js» не отдаёт исходники сервера',
  !/require\(|module\.exports/.test(traversal3.body), 'HTTP ' + traversal3.status + ': ' + traversal3.body.slice(0, 80));
const traversal4 = await rawRequest('/assets/../index.html');
checkTrue('нормализация пути отдаёт только разрешённые файлы', /ЖКУ/.test(traversal4.body) || traversal4.status >= 400,
  'HTTP ' + traversal4.status);

/* ========================================================================= */
section('10. Персистентность: перезапуск сервера');
const beforeRestart = await request('/api/state', { token: TOKEN });
const opsBefore = [
  { id: 'op-restart', type: 'upsert-entry', payload: Object.assign({}, entry, { id: 'en-restart', amount: 111.11, updatedAt: t2 }), at: t2 }
];
const beforeEv = await request('/api/events', { token: TOKEN, body: { ops: opsBefore, baseRevision: beforeRestart.json.revision, clientId: 'test' } });
check('запись добавлена перед перезапуском', beforeEv.json.state.journal.length, 1);
const revisionBefore = beforeEv.json.revision;
await stopServer();
await startServer();
const afterRestart = await request('/api/state', { token: TOKEN });
check('после перезапуска ревизия та же', afterRestart.json.revision, revisionBefore);
check('после перезапуска данные на месте', afterRestart.json.state.journal.length, 1);
check('после перезапуска сумма та же', afterRestart.json.state.journal[0].amount, 111.11);
const diskText = stateFileText();
checkTrue('data/state.js читается как обычный js-файл (rev' + revisionBefore + ')',
  diskText.includes('revision: ' + revisionBefore) || diskText.includes('"revision": ' + revisionBefore) || /revision:\s*' + revisionBefore + '/.test(diskText),
  diskText.split('\n').slice(0, 12).join(' | '));

/* ========================================================================= */
section('11. Сквозной сценарий: приложение в браузере (jsdom) ↔ сервер');
if (!JSDOM) {
  console.log(`  ${DIM}⚠️  jsdom не установлен — пропускаю клиентский сценарий (npm install --no-save jsdom)${RESET}`);
} else {
  /* Сервер должен знать стартовое состояние: одна запись за 2026-08 */
  await request('/api/import', {
    token: TOKEN,
    body: {
      state: {
        meta: { schemaVersion: 1 }, settings: { theme: 'dark' }, objects: {}, movements: [],
        journal: [{ id: 'en-remote', objectId: 'obj-04', serviceId: 'caprepair', period: '2026-08', date: '2026-08-31', amount: 602.80, updatedAt: t1 }],
        meterSnapshots: {}, tombstones: {}, outbox: []
      }
    }
  });

  const serverBeforeBoot = await request('/api/state', { token: TOKEN });

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const consoleErrors = [];
  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      /* jsdom не умеет fetch — отдаём приложению сетевой стек Node */
      window.fetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, BASE), init);
      window.localStorage.setItem('zhkx.server.v1', JSON.stringify({ token: TOKEN, autoSync: true, clientId: 'jsdom-test', url: '' }));
      /* «Непустая» локальная копия, чтобы приложение не наполнялось демо-данными:
         сервер — источник правды, локальная заглушка будет заменена при синхронизации. */
      window.localStorage.setItem('zhkx.crimea.state.v1', JSON.stringify({
        meta: { schemaVersion: 1, revision: 0, updatedAt: new Date().toISOString() },
        settings: {}, objects: {}, movements: [],
        journal: [{ id: 'local-placeholder', objectId: 'obj-01', serviceId: 'maintenance', period: '2026-07', date: '2026-07-31', amount: 1, updatedAt: new Date().toISOString() }],
        meterSnapshots: {}, tombstones: {}, outbox: []
      }));
      window.scrollTo = () => {};
      window.confirm = () => true;
      window.HTMLCanvasElement.prototype.getContext = function () { return null; };
      window.console.error = (...args) => consoleErrors.push(args.map(String).join(' '));
    }
  });

  const waitFor = async (fn, timeout = 15000, step = 120) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await fn()) return true; } catch (e) { /* ждём */ }
      await sleep(step);
    }
    return false;
  };

  const syncedInApp = await waitFor(() => dom.window.ZHKX && dom.window.ZHKX.Sync && dom.window.ZHKX.Sync.info().status === 'synced');
  checkTrue('приложение подключилось к серверу и синхронизировалось', syncedInApp,
    dom.window.ZHKX && dom.window.ZHKX.Sync ? JSON.stringify(dom.window.ZHKX.Sync.info().status) : 'нет модуля Sync');

  const appState = dom.window.ZHKX.State;
  check('приложение получило серверные данные (журнал)', appState.get().journal.length, serverBeforeBoot.json.state.journal.length);
  checkTrue('в журнале приложения именно серверная запись', appState.get().journal[0].id === 'en-remote',
    JSON.stringify(appState.get().journal.map((e) => e.id)));
  check('ревизия известна приложению', appState.revision(), serverBeforeBoot.json.revision);
  checkTrue('локальная заглушка заменена данными сервера', !appState.get().journal.some((e) => e.id === 'local-placeholder'));
  checkTrue('бейдж синхронизации в шапке показывает сервер',
    /Синхронизировано/.test(dom.window.document.getElementById('sync-badge').textContent || ''),
    dom.window.document.getElementById('sync-badge').textContent);

  /* Пользователь вносит начисление — оно должно уйти на сервер автоматически */
  const before = appState.revision();
  appState.addEntry({
    objectId: 'obj-04', serviceId: 'caprepair', period: '2026-09', date: '2026-09-30', amount: 602.80, amountSource: 'auto'
  });
  checkTrue('локальное изменение встало в очередь', appState.pendingCount() >= 1, String(appState.pendingCount()));
  const flushed = await waitFor(async () => {
    const remote = await request('/api/state', { token: TOKEN });
    return remote.json.state.journal.length === 2;
  }, 15000);
  checkTrue('изменение улетело на сервер автоматически', flushed, 'на сервере: ' + (await request('/api/state', { token: TOKEN })).json.state.journal.length + ' записей');
  const afterFlush = await request('/api/state', { token: TOKEN });
  checkTrue('на сервере есть запись за 2026-09', afterFlush.json.state.journal.some((e) => e.period === '2026-09'));
  checkTrue('ревизия на сервере выросла', afterFlush.json.revision > before, `${before} → ${afterFlush.json.revision}`);
  checkTrue('очередь приложения пуста после отправки', appState.pendingCount() === 0, String(appState.pendingCount()));

  /* Карточка «Сервер и синхронизация» в разделе «Данные» */
  dom.window.ZHKX.App.setView('data');
  const dataHtml = dom.window.document.getElementById('view-host').innerHTML;
  checkTrue('в разделе «Данные» есть карточка сервера', /card--sync/.test(dataHtml) && /state\.js/.test(dataHtml));
  checkTrue('карточка показывает ревизию сервера', /Ревизия файла состояния/.test(dataHtml));
  dom.window.ZHKX.SyncUI.open();
  checkTrue('окно синхронизации открылось с историей ревизий',
    /История ревизий/.test(dom.window.document.getElementById('modal-host').innerHTML));
  checkTrue('в окне есть форма входа/токена', /sync-autosync|Токен доступа/.test(dom.window.document.getElementById('modal-host').innerHTML));
  checkTrue('приложение работало без ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  dom.window.close();
}

/* ========================================================================= */
await stopServer();
console.log(`\n${BOLD}Итог тестов сервера:${RESET} ${GREEN}${passed} пройдено${RESET}, ${failed ? RED : DIM}${failed} не пройдено${RESET}`);
console.log(`${DIM}Изолированный каталог данных: ${DATA_DIR}${RESET}`);
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* оставим для разбора */ }
if (failed) process.exitCode = 1;
