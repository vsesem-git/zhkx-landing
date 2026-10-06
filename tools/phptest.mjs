/* ============================================================================
 *  tools/phptest.mjs — тесты папки для VPS («положил и открыл»): PHP + браузер
 *  ---------------------------------------------------------------------------
 *  Запуск:  npm run test:php        (или node tools/phptest.mjs)
 *
 *  Что проверяется на РЕАЛЬНОМ PHP (сборка dropin/):
 *    1. api.php обслуживает страницу состояния и маршрут health;
 *    2. открытый режим: приложение работает без токена, данные пишутся в
 *       zhkx-data/state.js (формат тот же, что у Node-сервера);
 *    3. «Закрыть паролем» создаёт токен, после чего без токена — 401;
 *    4. браузерный сценарий в jsdom: приложение само находит PHP-сервер,
 *       подтягивает данные, отправляет изменения и переживает закрытие доступа;
 *    5. клиентская проверка «каталог данных открыт наружу» (zhkx-data/state.js).
 *
 *  PHP ищется в таком порядке: $ZHKX_PHP_BIN → node_modules/.bin/php-wasm-cli
 *  (чистый WASM-PHP, ставится командой npm i --no-save @php-wasm/cli) → php в PATH.
 *  Если PHP нет вообще — тест честно сообщает об этом и пропускается (код 0).
 * ==========================================================================*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

let passed = 0, failed = 0, group = '';
function section(name) { group = name; console.log(`\n${BOLD}${name}${RESET}`); }
function check(label, actual, expected) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) <= 0.005 : actual === expected;
  if (ok) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}${typeof expected === 'number' ? DIM + ` → ${actual}` + RESET : ''}`); }
  else { failed++; console.log(`  ${RED}✗ ${label}${RESET}\n     ожидалось: ${expected}\n     получено : ${actual}`); }
}
function checkTrue(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}`); }
  else { failed++; console.log(`  ${RED}✗ ${label}${RESET} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- PHP --- */
function phpWorks(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch (e) {
    return false;
  }
}

function findPhp() {
  const local = process.env.ZHKX_PHP_BIN;
  if (local && fs.existsSync(local)) return local;
  const wasm = path.join(ROOT, 'node_modules', '.bin', 'php-wasm-cli');
  if (fs.existsSync(wasm)) return wasm;
  if (phpWorks('php', ['--version'])) return 'php';
  return null;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Сборка папки для VPS (dropin/) — тест всегда идёт по актуальным исходникам */
function buildDropin() {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-dropin.mjs')], { cwd: ROOT, stdio: 'ignore' });
}

/* ------------------------------------------------------------------ старт - */
const phpBin = findPhp();
if (!phpBin) {
  console.log(`\n${BOLD}Тесты PHP-сборки${RESET}`);
  console.log(`  ${DIM}⚠️  PHP не найден — пропускаю. Установите PHP 7.4+ либо выполните:` +
    `\n     npm install --no-save @php-wasm/cli@3   (WASM-сборка PHP для тестов)${RESET}\n`);
  process.exit(0);
}

buildDropin();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zhkx-php-'));
const appDir = path.join(work, 'zhkx');
fs.cpSync(path.join(ROOT, 'dropin'), appDir, { recursive: true });
fs.chmodSync(path.join(appDir, 'zhkx-data'), 0o777);

const port = await freePort();
const BASE = 'http://127.0.0.1:' + port;
const server = spawn(phpBin, ['-S', '127.0.0.1:' + port, '-t', appDir], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' })
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

const stopServer = () => new Promise((resolve) => {
  if (server.exitCode !== null) return resolve();
  server.once('exit', () => resolve());
  server.kill('SIGTERM');
  setTimeout(() => { try { server.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
});

/* Ждём готовности PHP-сервера */
let up = false;
for (let i = 0; i < 120; i++) {
  try {
    const res = await fetch(BASE + '/api.php?route=health');
    if (res.ok) { up = true; break; }
  } catch (e) { /* ещё не поднялся */ }
  await sleep(250);
}

if (!up) {
  console.log(`${RED}PHP-сервер не поднялся${RESET}`);
  console.log(DIM + serverLog.join('').split('\n').slice(-12).join('\n') + RESET);
  await stopServer();
  process.exit(1);
}

const dataDir = path.join(appDir, 'zhkx-data');
const readStateFile = () => fs.readFileSync(path.join(dataDir, 'state.js'), 'utf8');
const json = async (route, init) => {
  const res = await fetch(BASE + '/api.php?route=' + route, init);
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body, res };
};
const post = (route, payload, token) => json(route, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(payload || {})
});

/* ========================================================================= */
section('1. Страница состояния и health (www + PHP)');
const pageRes = await fetch(BASE + '/');
check('GET / (index.html) — 200', pageRes.status, 200);
const pageHtml = await pageRes.text();
checkTrue('отдана страница приложения', pageHtml.includes('ЖКУ · Крым'), pageHtml.slice(0, 60));
const statusPage = await fetch(BASE + '/api.php');
check('GET /api.php — 200 (страница состояния)', statusPage.status, 200);
checkTrue('страница состояния — HTML на русском', /PHP \d/.test(await statusPage.text()), 'нет версии PHP');

const health = await json('health');
check('GET api.php?route=health — 200', health.status, 200);
checkTrue('health отвечает нашим приложением', health.body && health.body.ok === true && health.body.app.id === 'zhkx-crimea',
  JSON.stringify(health.body && health.body.app));
check('движок в ответе — php', health.body.app.runtime, 'php');
check('файл состояния — zhkx-data/state.js', health.body.app.stateFile, 'zhkx-data/state.js');
check('режим доступа — открытый', health.body.auth.open, true);
check('справочники подхвачены: 6 объектов', health.body.config.objects, 6);

section('2. Открытый режим: данные пишутся в zhkx-data/state.js');
const state0 = await json('state');
check('GET state без токена — 200', state0.status, 200);
check('журнал пуст на старте', state0.body.state.journal.length, 0);
const ev = await post('events', {
  clientId: 'phptest',
  baseRevision: 0,
  ops: [{
    id: 'op-1', type: 'upsert-entry', at: new Date().toISOString(),
    payload: { id: 'en-1', objectId: 'obj-04', serviceId: 'caprepair', period: '2026-09', date: '2026-09-30', amount: 602.80 }
  }]
});
check('POST events — 200', ev.status, 200);
check('запись применена', ev.body.state.journal.length, 1);
check('ревизия выросла', ev.body.revision, 1);
checkTrue('файл zhkx-data/state.js содержит маркер состояния', readStateFile().includes('window.ZHKX.StateData = '), readStateFile().slice(0, 80));
checkTrue('в файле — новая ревизия', /"revision": 1/.test(readStateFile()), '');
checkTrue('история ревизий создана', fs.readdirSync(path.join(dataDir, 'history')).length >= 1,
  JSON.stringify(fs.readdirSync(path.join(dataDir, 'history'))));

const configRoute = await json('config');
check('GET config — 200', configRoute.status, 200);
check('config: 6 объектов', configRoute.body.objects.length, 6);
checkTrue('config: валидация без замечаний', configRoute.body.validation.ok === true,
  JSON.stringify(configRoute.body.validation.problems));
const reminders = await json('reminders');
check('GET reminders — 200', reminders.status === 40 || reminders.status === 200 ? 200 : reminders.status, 200);
checkTrue('напоминания сформированы', Array.isArray(reminders.body.reminders) && reminders.body.reminders.length > 0,
  'напоминаний: ' + (reminders.body.reminders || []).length);

const stateFileOpen = await fetch(BASE + '/api.php?route=state-file');
check('скачивание state.js без токена в открытом режиме — 200', stateFileOpen.status, 200);
checkTrue('скачанный файл — тот же формат', (await stateFileOpen.text()).includes('StateData'));

section('3. «Закрыть паролем»');
const lock = await post('lock', {});
check('POST lock — 200', lock.status, 200);
const TOKEN = lock.body.token;
checkTrue('токен создан (32 hex-символа)', typeof TOKEN === 'string' && /^[0-9a-f]{32}$/.test(TOKEN), String(TOKEN));
checkTrue('токен сохранён в zhkx-data/auth.json', fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8').includes(TOKEN));
const healthLocked = await json('health');
check('после закрытия health: открытый режим выключен', healthLocked.body.auth.open, false);
check('после закрытия health: нужен токен', healthLocked.body.auth.authRequired, true);
const stateNoToken = await json('state');
check('GET state без токена — 401', stateNoToken.status, 401);
const stateWithToken = await json('state', { headers: { Authorization: 'Bearer ' + TOKEN } });
check('GET state с токеном — 200', stateWithToken.status, 200);
const stateByIdToken = await json('state-file', { headers: { Authorization: 'Bearer ' + TOKEN } });
check('state-file с токеном — 200', stateByIdToken.status, 200);
const badToken = await json('state', { headers: { Authorization: 'Bearer wrong-token-0123456789' } });
check('неверный токен — 401', badToken.status, 401);
const login = await post('login', { token: TOKEN });
check('POST login с верным токеном — 200', login.status, 200);
const loginBad = await post('login', { token: 'wrong-token-0123456789' });
checkTrue('POST login с неверным токеном — 401/429', loginBad.status === 401 || loginBad.status === 429, String(loginBad.status));

section('4. Ревизии, экспорт и откат');
const revisions = await json('revisions', { headers: { Authorization: 'Bearer ' + TOKEN } });
check('GET revisions — 200', revisions.status, 200);
checkTrue('в истории есть записи', Array.isArray(revisions.body.revisions) && revisions.body.revisions.length >= 1,
  JSON.stringify(revisions.body.revisions || revisions.body));
const backup = await json('export', { headers: { Authorization: 'Bearer ' + TOKEN } });
check('GET export — 200', backup.status, 200);
check('формат бэкапа', backup.body.format, 'zhkx-crimea-backup');
check('в бэкапе одна запись журнала', backup.body.summary.journalEntries, 1);

/* ========================================================================= */
section('5. Приложение в браузере (jsdom) ↔ PHP-сервер');
let jsdomOk = true;
let JSDOM = null;
try { JSDOM = (await import('jsdom')).JSDOM; } catch (e) { jsdomOk = false; }

if (!jsdomOk) {
  console.log(`  ${DIM}⚠️  jsdom не установлен — пропускаю браузерный сценарий${RESET}`);
} else {
  /* Разрешаем доступ заново — так пользователь и увидит «залил и открыл» */
  fs.rmSync(path.join(dataDir, 'auth.json'), { force: true });

  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  const consoleErrors = [];
  const dom = new JSDOM(html, {
    url: BASE + '/index.html',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, BASE), init);
      window.scrollTo = () => {};
      window.confirm = () => true;
      window.HTMLCanvasElement.prototype.getContext = function () { return null; };
      window.console.error = (...args) => consoleErrors.push(args.map(String).join(' '));
    }
  });

  const waitFor = async (fn, timeout = 20000, step = 150) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await fn()) return true; } catch (e) { /* ждём */ }
      await sleep(step);
    }
    return false;
  };

  const ready = await waitFor(() => dom.window.ZHKX && dom.window.ZHKX.Sync && dom.window.ZHKX.App && dom.window.ZHKX.App.ready);
  checkTrue('приложение загрузилось в браузере', ready, 'нет ZHKX.App');

  const Sync = dom.window.ZHKX.Sync;
  const State = dom.window.ZHKX.State;
  const connected = await waitFor(() => ['synced', 'pending'].includes(Sync.info().status));
  checkTrue('приложение само нашло PHP-сервер', connected, 'статус: ' + Sync.info().status);
  check('движок определён как PHP', Sync.info().apiKind, 'php');
  checkTrue('подпись движка для интерфейса — «PHP на хостинге»', Sync.info().apiKindLabel === 'PHP на хостинге', Sync.info().apiKindLabel);
  check('сервер открыт (без пароля)', Sync.info().open, true);
  check('данные подтянуты с сервера: одна запись', State.get().journal.length, 1);
  checkTrue('это именно серверная запись', State.get().journal[0] && State.get().journal[0].id === 'en-1',
    JSON.stringify(State.get().journal.map((e) => e.id)));
  checkTrue('карточка сервера объясняет, что данные в zhkx-data/state.js',
    /zhkx-data\/state\.js/.test(dom.window.document.getElementById('view-host').innerHTML) ||
    /zhkx-data\/state\.js/.test(dom.window.document.body.innerHTML),
    'упоминания нет');

  /* Клиентская проверка «каталог данных открыт»: встроенный PHP-сервер отдаёт файл */
  const exposureChecked = await waitFor(() => Sync.info().exposed !== null && Sync.info().exposed !== undefined, 8000);
  checkTrue('приложение проверяет, не отдаётся ли zhkx-data/state.js наружу', exposureChecked,
    'exposed: ' + String(Sync.info().exposed));
  check('на встроенном PHP-сервере файл действительно открыт → предупреждение', Sync.info().exposed, true);

  /* Пользователь вносит начисление — оно должно уйти на сервер само */
  State.addEntry({ objectId: 'obj-01', serviceId: 'caprepair', period: '2026-09', date: '2026-09-30', amount: 750, amountSource: 'auto' });
  checkTrue('изменение встало в очередь', State.pendingCount() >= 1, String(State.pendingCount()));
  const flushed = await waitFor(async () => {
    const remote = await json('state');
    return remote.body.state.journal.length === 2;
  }, 20000);
  checkTrue('изменение улетело на сервер автоматически', flushed,
    'на сервере: ' + (await json('state')).body.state.journal.length + ' записей');
  checkTrue('очередь пуста после отправки', State.pendingCount() === 0, String(State.pendingCount()));

  /* Закрываем доступ из интерфейса — как это сделает пользователь */
  const locked = await Sync.lock().then(() => true).catch((e) => { console.log('    lock error: ' + e.message); return false; });
  checkTrue('кнопка «Закрыть паролем» сработала', locked);
  checkTrue('токен сохранён в браузере', !!Sync.info().token);
  check('после закрытия сервер не открыт', Sync.info().open, false);
  checkTrue('файл auth.json создан на сервере', fs.existsSync(path.join(dataDir, 'auth.json')));
  const stateAfterLock = await json('state');
  check('после закрытия без токена — 401', stateAfterLock.status, 401);
  const pullAgain = await Sync.pull().then(() => true).catch(() => false);
  checkTrue('приложение продолжает работать по токену', pullAgain);

  checkTrue('приложение работало без ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  dom.window.close();
}

await stopServer();

/* ========================================================================= */
console.log(`\n${BOLD}Итог PHP-тестов:${RESET} ${GREEN}${passed} пройдено${RESET}, ${failed ? RED : DIM}${failed} не пройдено${RESET}`);
console.log(`${DIM}Папка для VPS: dropin/ · архив: dist/zhkx-vps-php.zip${RESET}`);
if (failed) process.exitCode = 1;
