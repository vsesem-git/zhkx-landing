/* ============================================================================
 *  tools/seed-server.mjs — наполнение серверного хранилища данными
 *  ---------------------------------------------------------------------------
 *  Запуск:  node tools/seed-server.mjs            (npm run seed)
 *           node tools/seed-server.mjs --demo     — демо-история за 12 месяцев
 *           node tools/seed-server.mjs --file backup.json
 *           node tools/seed-server.mjs --url http://localhost:8000 --token …
 *
 *  Что делает:
 *    1. берёт готовый JSON-бэкап (файл или localStorage браузера выгрузить
 *       нельзя — поэтому по умолчанию собирается состояние из data-слоя);
 *    2. отправляет его на сервер в /api/import — состояние заменяется целиком,
 *       прежняя версия остаётся в истории ревизий data/history/;
 *    3. печатает итоговую ревизию и статистику.
 *
 *  Источник токена: --token, переменная ZHKX_TOKEN или data/auth.json.
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes('--' + name);

const BASE = (getArg('url', process.env.ZHKX_URL || 'http://127.0.0.1:8000')).replace(/\/+$/, '');
const DATA_DIR = process.env.ZHKX_DATA_DIR ? path.resolve(process.env.ZHKX_DATA_DIR) : path.join(ROOT, 'data');

function token() {
  const explicit = getArg('token', process.env.ZHKX_TOKEN || '');
  if (explicit) return explicit;
  if (process.env.ZHKX_DEMO_AUTH === '1') return 'demo-token';
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'auth.json'), 'utf8')).token;
  } catch (e) {
    return null;
  }
}

/* ------------------------------- состояние из кода приложения (тот же seed) -- */
/**
 * Запускает data-слой и ядро состояния приложения в песочнице Node с поддельным
 * localStorage и возвращает состояние, готовое к отправке на сервер. Так демо-данные
 * на сервере получаются ровно такими же, как кнопка «Наполнить демо-данными»
 * в интерфейсе (включая архивы водомеров, показания и крупные авансы).
 */
function buildStateFromApp({ months = 12, fresh = true } = {}) {
  const store = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      get length() { return store.size; },
      key: (i) => Array.from(store.keys())[i] ?? null
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const files = [
    'assets/js/data/config.js',
    'assets/js/core/utils.js',
    'assets/js/core/tariff-engine.js',
    'assets/js/core/state.js'
  ];
  for (const rel of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }

  const State = sandbox.ZHKX.State;
  if (fresh) State.reset();
  const seeded = State.seedDemo({ months });
  return { state: State.snapshotForServer(), seeded };
}

/* ------------------------------------------------------------------- main -- */
const authToken = token();
if (!authToken) {
  console.error('\n❌ Не найден токен доступа.');
  console.error('   Запустите сервер (npm start) и возьмите токен:  npm run token');
  console.error('   либо укажите его явно:                        node tools/seed-server.mjs --token <токен>\n');
  process.exit(1);
}

let state;
let sourceLabel;
const fileArg = getArg('file', null);
if (fileArg) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  state = parsed.state || parsed;
  sourceLabel = 'файл ' + fileArg;
} else {
  const months = Number(getArg('months', hasFlag('demo') ? 12 : 6));
  const built = buildStateFromApp({ months });
  state = built.state;
  sourceLabel = 'демо-состояние приложения за ' + months + ' мес. (как кнопка «Наполнить демо-данными»)';
}

console.log('\n  🏠  Наполнение сервера ЖКУ · Крым');
console.log('  ─────────────────────────────────────────────────────');
console.log('  Сервер        : ' + BASE);
console.log('  Источник      : ' + sourceLabel);

delete state.outbox;
console.log('  Записей       : ' + state.journal.length + ' · движений ' + state.movements.length +
  ' · объектов с правками ' + Object.keys(state.objects).length);

const res = await fetch(BASE + '/api/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
  body: JSON.stringify({ state, clientId: 'seed-script' })
});

const json = await res.json().catch(() => null);
if (!res.ok || !json || json.ok === false) {
  console.error('\n❌ Сервер отказался принять данные (HTTP ' + res.status + '): ' + ((json && json.error) || 'без описания'));
  console.error('   Проверьте, что сервер запущен: npm start (или npm run dev)\n');
  process.exit(1);
}

const after = await (await fetch(BASE + '/api/state', { headers: { Authorization: 'Bearer ' + authToken } })).json();
console.log('  ─────────────────────────────────────────────────────');
console.log('  ✅ Загружено. Ревизия: r' + after.revision);
console.log('  Начислений    : ' + after.state.journal.length);
console.log('  Движений      : ' + after.state.movements.length);
console.log('  Объектов      : 6 в реестре (правок пользователя: ' + Object.keys(after.state.objects).length + ')');
console.log('  Обновлено     : ' + after.updatedAt);
console.log('  ─────────────────────────────────────────────────────');
console.log('  Открыть приложение: ' + BASE + '/\n');
