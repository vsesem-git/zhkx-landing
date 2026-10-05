/* ============================================================================
 *  tools/build-demo.mjs — сборка демо-бандлов для публикации и развёртывания
 *  ---------------------------------------------------------------------------
 *  Запуск:  npm run build:demo
 *
 *  Результат:
 *    • docs/                       — статическое демо прямо в репозитории (для
 *                                    развёртывания копированием и GitHub Pages);
 *    • dist/*.zip                  — те же файлы архивами для скачивания.
 *
 *  Собирает два архива (ZIP, без внешних зависимостей):
 *
 *    1. dist/zhkx-demo-static.zip  — статическое демо интерфейса.
 *       Кладётся на любой веб-сервер или в GitHub Pages: приложение работает
 *       само, история — в localStorage браузера, при первом запуске
 *       наполняется демонстрационной историей. Сервер не нужен.
 *
 *    2. dist/zhkx-server.zip       — полный комплект для своего сервера:
 *       приложение + сервер хранения data/state.js, CLI, тесты и файлы
 *       развёртывания (Docker, systemd, nginx). Данные в архив НЕ попадают.
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/* ------------------------------------------------------------------ файлы -- */
function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Интерфейс приложения — то, что нужно статическому демо */
const APP_FILES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  ...walk(path.join(ROOT, 'assets')).map((f) => 'assets/' + f)
];

/** Всё необходимое для запуска на своём сервере (без данных и зависимостей) */
const SERVER_FILES = [
  ...APP_FILES,
  'package.json',
  'README.md',
  ...walk(path.join(ROOT, 'server')).map((f) => 'server/' + f),
  ...walk(path.join(ROOT, 'tools')).map((f) => 'tools/' + f),
  ...walk(path.join(ROOT, 'deploy')).map((f) => 'deploy/' + f),
  '.dockerignore',
  '.gitignore'
];

/* ------------------------------------------------------------------- ZIP --- */
/* Минимальный ZIP-писатель (deflate + UTF-8 имена) — без внешних зависимостей. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  entries.forEach((entry) => {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    /* Сжимаем только если это действительно выгодно */
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                 // версия для распаковки
    local.writeUInt16LE(0x0800, 6);             // имена в UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); // метод: deflate | store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);       // сжатый размер
    local.writeUInt32LE(raw.length, 22);        // исходный размер
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuffer, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuffer.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  });

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

/* -------------------------------------------------------------- материалы -- */
function readFiles(files) {
  return files.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) }));
}

const DEMO_README = `ЖКУ · Крым — демонстрационная сборка v${VERSION}
${'='.repeat(60)}

Это статическая версия интерфейса: сервер не нужен, все данные хранятся
в localStorage браузера. При первом открытии приложение наполняет себя
демонстрационной историей за 12 месяцев (включая реальные архивы водомеров
по кв. 115, 3 и 102); очистить её можно в разделе «Данные» → «Очистить всё».

Как развернуть
--------------
1. Скопируйте эту папку (её содержимое) в каталог веб-сервера, например:
     sudo mkdir -p /var/www/zhkx-demo
     sudo cp -r docs/* /var/www/zhkx-demo/          # из клона репозитория
   или, с локального компьютера:
     rsync -a docs/ user@ваш-сервер:/var/www/zhkx-demo/
2. Откройте в браузере (или настройте nginx на этот каталог):
     http://ваш-сервер/zhkx-demo/
   Он же может быть источником GitHub Pages: Settings → Pages → ветка + /docs.
3. Интернет не требуется: Chart.js подгружается с CDN, но при его отсутствии
   автоматически включается встроенный canvas-рендерер диаграмм.

Важно про безопасность
----------------------
В статической сборке данные объектов (адреса, ФИО, лицевые счета, тарифы)
находятся в файле assets/js/data/config.js и доступны любому, кто откроет
страницу. Если выкладываете демо в открытый доступ — закройте его basic-auth
(пример: deploy/nginx.conf.example) или используйте сборку с сервером.

Хотите настоящее хранилище на сервере (data/state.js, история ревизий,
синхронизация, напоминания в Telegram) — возьмите архив zhkx-server.zip
или сам репозиторий: npm start. Подробности — в README.md.
`;

const SERVER_README = `ЖКУ · Крым — полный комплект для своего сервера v${VERSION}
${'='.repeat(60)}

Внутри: приложение (index.html, assets/), сервер хранения данных (server/),
служебные скрипты (tools/), файлы развёртывания (deploy/) и документация.

Быстрый старт (нужен Node.js 18+)
---------------------------------
   npm start                 # → http://localhost:8000, токен печатается в консоль
   npm run dev               # демо-режим: токен «demo-token», вход без ввода
   npm run seed -- --demo    # наполнить сервер демонстрационной историей
   npm run status | token | revisions | backup | reminders | validate

Данные появляются в каталоге data/ (в архив не входят):
   data/state.js            состояние: журнал, кошельки, показания, настройки
   data/history/…           до 60 последних ревизий файла состояния
   data/auth.json           токен доступа (создаётся сам, права 600)

Развёртывание
-------------
* Docker:      docker build -f deploy/Dockerfile -t zhkx-crimea:${VERSION} .
               docker run -d -p 8000:8000 -v zhkx-data:/app/data -e ZHKX_TOKEN=… zhkx-crimea:${VERSION}
* Compose:     docker compose -f deploy/docker-compose.yml up -d
* systemd:     deploy/zhkx.service → /etc/systemd/system/
* nginx:       deploy/nginx.conf.example (обратный прокси + basic-auth + HTTPS)
* Демо без сервера: статическая сборка zhkx-demo-static.zip

Обязательно поменяйте токен доступа (ZHKX_TOKEN) и закройте страницу от чужих:
в приложении есть адреса, ФИО и лицевые счета. Тесты: npm run test:all.
`;

/* ------------------------------------------------------------------- сборка */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

/* Статическое демо в репозитории: docs/ — складывается копированием на сервер,
   и его же можно указать как источник GitHub Pages (ветка → /docs). */
const DOCS = path.join(ROOT, 'docs');

function writeDocs(entries) {
  fs.rmSync(DOCS, { recursive: true, force: true });
  fs.mkdirSync(DOCS, { recursive: true });
  for (const entry of entries) {
    const full = path.join(DOCS, entry.name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.data);
  }
}

const staticEntries = [
  ...readFiles(APP_FILES),
  { name: 'ПРОЧТИ-МЕНЯ.txt', data: Buffer.from(DEMO_README, 'utf8') }
];
const staticZip = createZip(staticEntries);
fs.writeFileSync(path.join(DIST, 'zhkx-demo-static.zip'), staticZip);
writeDocs(staticEntries);

const serverEntries = [
  ...readFiles(SERVER_FILES),
  { name: 'ПРОЧТИ-МЕНЯ.txt', data: Buffer.from(SERVER_README, 'utf8') }
];
const serverZip = createZip(serverEntries);
fs.writeFileSync(path.join(DIST, 'zhkx-server.zip'), serverZip);

/* Распакованные каталоги — чтобы можно было посмотреть и сразу разложить */
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
fs.writeFileSync(path.join(DIST, 'zhkx-demo-static.zip.sha256'), sha256(staticZip) + '  zhkx-demo-static.zip\n');
fs.writeFileSync(path.join(DIST, 'zhkx-server.zip.sha256'), sha256(serverZip) + '  zhkx-server.zip\n');

const kb = (b) => (b / 1024).toFixed(1) + ' КБ';
console.log('\n  📦  Сборка демо-бандлов ЖКУ · Крым v' + VERSION);
console.log('  ─────────────────────────────────────────────────────────');
console.log('  docs/                      ' + kb(staticZip.length).padStart(9) + '  ' + staticEntries.length + ' файлов — демо в репозитории (для своего сервера и GitHub Pages)');
console.log('  dist/zhkx-demo-static.zip  ' + kb(staticZip.length).padStart(9) + '  ' + staticEntries.length + ' файлов — интерфейс без сервера');
console.log('  dist/zhkx-server.zip       ' + kb(serverZip.length).padStart(9) + '  ' + serverEntries.length + ' файлов — приложение + сервер + deploy/');
console.log('  Контрольные суммы: dist/*.sha256');
console.log('  ─────────────────────────────────────────────────────────');
console.log('  Разложить демо на своём сервере:  rsync -a docs/ user@сервер:/var/www/zhkx-demo/');
console.log('  Включить GitHub Pages:            gh api -X POST repos/ВЛАДЕЛЕЦ/РЕПО/pages \\');
console.log('                                      -f "source[branch]=ВЕТКА" -f "source[path]=/docs"');
console.log('  Опубликовать релиз с архивами:    gh release create v' + VERSION + ' dist/*.zip dist/*.sha256');
console.log('  Развёртывание с сервером:         см. deploy/ (Docker, compose, systemd, nginx)\n');
