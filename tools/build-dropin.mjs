/* ============================================================================
 *  tools/build-dropin.mjs — сборка папки «залил на VPS и открыл» (PHP)
 *  ---------------------------------------------------------------------------
 *  Запуск:  npm run build:dropin
 *
 *  Результат:
 *    • dropin/            — готовая папка: положить на хостинг/VPS и открыть;
 *    • dist/zhkx-vps-php.zip (+ .sha256) — тот же комплект архивом.
 *
 *  Внутри папки:
 *    index.html, assets/, manifest.webmanifest, sw.js   — сам интерфейс;
 *    api.php            — хранилище данных на PHP (7.4+), без базы данных;
 *    config.generated.json — справочники объектов и тарифов из data-слоя
 *                            (нужны серверу для проверок и напоминаний);
 *    zhkx-data/         — сюда PHP складывает state.js, ревизии и токен;
 *    .htaccess          — настройки для Apache (и запрет доступа к данным);
 *    nginx.conf.example — то же самое для nginx + PHP-FPM;
 *    ПРОЧТИ-МЕНЯ.txt    — инструкция «что делать дальше» простыми словами.
 *
 *  Node.js-сервер (server/) в эту сборку НЕ входит: она рассчитана на
 *  обычный хостинг с PHP, где ничего запускать руками не нужно.
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'dropin');
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

/** Что нужно положить в папку на хостинге */
const APP_FILES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  ...walk(path.join(ROOT, 'assets')).map((f) => 'assets/' + f)
];

/* ------------------------------------------------------------ справочники -- */
/* config.generated.json собирает тот же загрузчик data-слоя, что использует
   Node-сервер: один источник правды, никакого дублирования цифр. */
function buildConfigJson() {
  const loader = require(path.join(ROOT, 'server', 'config-loader.js'));
  const validation = loader.validate();
  return {
    generatedAt: new Date().toISOString(),
    appVersion: VERSION,
    app: loader.status().app,
    source: 'assets/js/data/config.js',
    objects: loader.objects(),
    tariffs: loader.tariffs(),
    meters: loader.meters(),
    validation
  };
}

/* ------------------------------------------------------------------- ZIP --- */
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
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
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
const HTACCESS_ROOT = `# ЖКУ · Крым — папка для хостинга с PHP (Apache)
# Кладётся в корень сайта или в подпапку. Ничего кроме этого файла настраивать
# не нужно: index.html отдаётся сразу, api.php хранит данные в zhkx-data/.

DirectoryIndex index.html index.php

# Кодировка и типы файлов
AddDefaultCharset UTF-8
AddType application/manifest+json .webmanifest
AddType application/javascript .js

# Служебные каталоги не показываем в листингах
Options -Indexes

# Данные приложения НИКОГДА не должны отдаваться браузеру напрямую:
# их читает и пишет только api.php.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^zhkx-data/ - [F,L]
</IfModule>

# Кэш статики (интерфейс можно кэшировать, данные — нет)
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/css "access plus 7 days"
  ExpiresByType application/javascript "access plus 7 days"
  ExpiresByType image/svg+xml "access plus 30 days"
</IfModule>
`;

const HTACCESS_DATA = `# Внутрь каталога с данными не должен попадать никто, кроме api.php
<IfModule mod_authz_core.c>
  Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
  Order allow,deny
  Deny from all
</IfModule>
`;

const DATA_GITIGNORE = `# state.js, ревизии и токен создаются api.php на сервере — в git им не место
*
!.gitignore
!index.html
!.htaccess
!config.php.example
`;

const DATA_INDEX = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>ЖКУ · Крым — служебный каталог</title></head>
<body style="font-family:system-ui,sans-serif;background:#0b1220;color:#e2e8f0;padding:2rem">
<h1>Служебный каталог</h1>
<p>Здесь api.php хранит файл состояния <code>state.js</code>, историю ревизий и токен доступа.</p>
<p>Смотреть данные — в приложении: <a style="color:#38bdf8" href="../index.html">открыть «ЖКУ · Крым»</a>.</p>
</body></html>
`;

const CONFIG_PHP_EXAMPLE = `<?php
/* ============================================================================
 *  zhkx-data/config.php — НЕОБЯЗАТЕЛЬНЫЕ настройки хранилища.
 *  Файл для PHP: просто скопируйте его из config.php.example в config.php
 *  и поправьте значения. Если файла нет — всё работает и без него.
 *
 *  Токен можно не прописывать вручную: откройте приложение и нажмите
 *  «Закрыть паролем» — токен создастся сам и сохранится в zhkx-data/auth.json.
 * ==========================================================================*/

return [
    /* Постоянный токен доступа (минимум 8 символов). Уберите строку — токен
       будет взят из auth.json (создаётся кнопкой «Закрыть паролем»). */
    'token' => '',

    /* Напоминания в Telegram (необязательно).
       Как получить: напишите @BotFather → /newbot → получите токен бота,
       затем напишите своему боту любое сообщение и узнайте chat_id
       у @userinfobot. */
    'telegram' => [
        'token' => '',
        'chat' => ''
    ],

    /* Сколько последних ревизий файла состояния хранить (по умолчанию 60) */
    'history_limit' => 60
];
`;

const NGINX_EXAMPLE = `# ЖКУ · Крым — пример настройки nginx для VPS (nginx + PHP-FPM)
# Проверено для https://сервер/zhkx/  и  https://сервер/   (папка в корне)
#
# 1. Скопируйте папку с приложением, например в /var/www/zhkx
# 2. Создайте /etc/nginx/sites-available/zhkx.conf с этим содержимым
# 3. ln -s /etc/nginx/sites-available/zhkx.conf /etc/nginx/sites-enabled/
# 4. nginx -t && systemctl reload nginx
#
# Замените сервер и путь. unix:/run/php/php8.2-fpm.sock — сокет вашего PHP-FPM
# (посмотрите версию: ls /run/php/).

server {
    listen 80;
    server_name ваш-сервер.example;

    root /var/www/zhkx;
    index index.html index.php;

    charset utf-8;
    client_max_body_size 16m;          # резервные копии JSON бывают крупными

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Данные приложения: только через api.php, наружу — запрет
    location ~ ^/(zhkx-data|data)/ {
        deny all;
        return 404;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        fastcgi_read_timeout 60s;
    }

    # Интерфейс можно кэшировать, данные — нет
    location ~* \\.(css|js|svg|webmanifest)$ {
        expires 7d;
        add_header Cache-Control "public";
    }
}
`;

const README = `ЖКУ · Крым — папка для VPS/хостинга с PHP (версия ${VERSION})
${'='.repeat(72)}

Данные хранятся на вашем сервере в обычном .js-файле zhkx-data/state.js.
Никаких баз данных, Node.js, npm и сборок — только PHP и веб-сервер.


ЧТО ДЕЛАТЬ (2 минуты)
---------------------
1. Залейте ЭТУ ПАПКУ со всем содержимым на сервер, например в
   /var/www/zhkx  (или в подпапку сайта: /var/www/html/zhkx).

     с домашнего компьютера:
       scp -r dropin/ user@ваш-сервер:/var/www/zhkx/
     или прямо из репозитория на сервере:
       git clone https://github.com/vsesem-git/zhkx-landing.git
       cp -r zhkx-landing/dropin /var/www/zhkx

2. Разрешите PHP писать в каталог данных:
       chmod -R 775 /var/www/zhkx/zhkx-data

3. Откройте в браузере:
       http://ваш-сервер/            (если папка в корне сайта)
       http://ваш-сервер/zhkx/       (если в подпапке)

Всё. Приложение откроется, данные будут сохраняться в zhkx-data/state.js.
Проверить сервер можно по адресу  http://ваш-сервер/api.php — там страница
состояния: версия PHP, ревизия данных, права на каталог, защита каталога.


ЧТО НАСТРОИТЬ СРАЗУ (важно)
---------------------------
1. ПАРОЛЬ. Первый запуск открыт всем, кто знает адрес. Откройте раздел
   «Данные» → «Сервер и синхронизация» → «🔒 Закрыть паролем»: приложение
   создаст токен, покажет его и запомнит. На телефоне введите тот же токен —
   данные подтянутся. Токен лежит в файле zhkx-data/auth.json (права 600).
   Так же работает и вход на другом компьютере: адрес тот же, токен тот же.

2. ЗАЩИТА КАТАЛОГА ДАННЫХ. Файл zhkx-data/state.js не должен открываться
   по прямой ссылке — в нём адреса, ФИО и лицевые счета.
     • Apache: файл zhkx-data/.htaccess уже лежит в папке, делать ничего не нужно.
     • nginx:  добавьте в конфиг сайта (см. nginx.conf.example):
                   location ~ ^/(zhkx-data|data)/ { deny all; return 404; }
   Приложение само проверяет доступность файла и пишет в окне синхронизации,
   если каталог открыт наружу.

3. TELEGRAM-НАПОМИНАНИЯ (по желанию). Скопируйте
   zhkx-data/config.php.example → zhkx-data/config.php и впишите токен бота
   и chat_id. Напоминания: передать показания 20–25 числа, срок госповерки,
   заканчивающийся аванс и появившийся долг. Список можно посмотреть и без
   бота: раздел «Данные» → «Напоминания».

4. HTTPS. Если домен есть — включите сертификат (Let's Encrypt: certbot).
   По HTTPS приложение устанавливается на телефон как PWA и работает офлайн.


ЧТО ВНУТРИ
----------
  index.html, assets/, manifest.webmanifest, sw.js — интерфейс приложения;
  api.php                  — сервер хранения данных (PHP 7.4+, без БД);
  config.generated.json    — справочники объектов и тарифов (из data-слоя);
  zhkx-data/               — ДАННЫЕ: state.js (журнал, кошельки, показания),
                             history/ (до 60 ревизий с откатом), auth.json (токен);
  .htaccess                — настройки для Apache, включая запрет zhkx-data;
  nginx.conf.example       — готовый конфиг для nginx + PHP-FPM;
  zhkx-data/config.php.example — шаблон настроек (токен, Telegram);
  ПРОЧТИ-МЕНЯ.txt          — этот файл.

Интерфейс можно открыть и вообще без PHP: тогда он работает полностью в
браузере (данные в localStorage), а на сервер начнёт писать, когда PHP есть.
Если PHP отсутствует, api.php просто отдаст ошибку — приложение это заметит
и перейдёт в локальный режим, ничего не сломается.


РЕЗЕРВНЫЕ КОПИИ И ПЕРЕНОС
-------------------------
  • Раздел «Данные» → «Скачать JSON-бэкап» — файл со всеми записями.
  • Раздел «Данные» → «Импорт» — восстановление из бэкапа.
  • Файл zhkx-data/state.js можно просто скопировать на другой сервер:
        scp user@сервер:/var/www/zhkx/zhkx-data/state.js .
  • Переехать на другой хостинг: скопируйте папку вместе с zhkx-data/.
  • Ошиблись в правках? Раздел «Данные» → история ревизий → «Откатить».

Требования: PHP 7.4+ (проверено на 8.x), права на запись в zhkx-data.
Расширения: json, mbstring, hash (есть на любом обычном хостинге).

Полная документация, Node.js-вариант с тем же файлом состояния,
Docker/systemd и тесты — в репозитории: https://github.com/vsesem-git/zhkx-landing
`;

/* ------------------------------------------------------------------- сборка */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

const entries = [];

function write(rel, data) {
  const full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  fs.writeFileSync(full, buffer);
  entries.push({ name: rel, data: buffer });
}

/* 1. Интерфейс приложения */
for (const rel of APP_FILES) {
  write(rel, fs.readFileSync(path.join(ROOT, rel)));
}

/* 2. Серверная часть на PHP */
write('api.php', fs.readFileSync(path.join(ROOT, 'php', 'api.php')));

/* 3. Справочники из data-слоя */
const configJson = buildConfigJson();
write('config.generated.json', JSON.stringify(configJson, null, 2) + '\n');

/* 4. Каталог данных и защита */
write('.htaccess', HTACCESS_ROOT);
write(path.join('zhkx-data', '.htaccess'), HTACCESS_DATA);
write(path.join('zhkx-data', '.gitignore'), DATA_GITIGNORE);
write(path.join('zhkx-data', 'index.html'), DATA_INDEX);
write(path.join('zhkx-data', 'config.php.example'), CONFIG_PHP_EXAMPLE);

/* 5. Инструкции */
write('ПРОЧТИ-МЕНЯ.txt', README);
write('nginx.conf.example', NGINX_EXAMPLE);

/* 6. Архив для скачивания */
entries.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const zip = createZip(entries);
const sha = crypto.createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(path.join(DIST, 'zhkx-vps-php.zip'), zip);
fs.writeFileSync(path.join(DIST, 'zhkx-vps-php.zip.sha256'), sha + '  zhkx-vps-php.zip\n');

/* ------------------------------------------------------------------- итог --- */
const kb = (b) => (b / 1024).toFixed(1) + ' КБ';
const phpApi = entries.find((e) => e.name === 'api.php');
console.log('\n  📦  Папка для VPS/хостинга с PHP — ЖКУ · Крым v' + VERSION);
console.log('  ───────────────────────────────────────────────────────────────');
console.log('  dropin/                    ' + entries.length + ' файлов (' + kb(zip.length) + ' архивом)');
console.log('  ├─ index.html + assets/    интерфейс приложения');
console.log('  ├─ api.php                 ' + kb(phpApi.data.length) + ' — хранилище на PHP ' +
  '(' + configJson.objects.length + ' объектов, ' + configJson.meters.length + ' приборов учёта)');
console.log('  ├─ config.generated.json   справочники из assets/js/data/config.js');
console.log('  ├─ zhkx-data/              сюда пишутся state.js, ревизии и токен');
console.log('  ├─ .htaccess               Apache: запрет доступа к zhkx-data/');
console.log('  └─ nginx.conf.example      nginx + PHP-FPM: то же самое');
console.log('  dist/zhkx-vps-php.zip      архив для загрузки на сервер');
console.log('  ───────────────────────────────────────────────────────────────');
if (!configJson.validation.ok) {
  console.log('  ⚠️  Валидация data-слоя: ' + configJson.validation.problems.join('; '));
} else {
  console.log('  ✅ Валидация data-слоя без замечаний');
}
console.log('  Положить на сервер:  scp -r dropin/ user@сервер:/var/www/zhkx/');
console.log('  Затем открыть в браузере и нажать «Закрыть паролем».\n');
