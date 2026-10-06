#!/usr/bin/env node
/* ============================================================================
 *  server/cli.js — СЛУЖЕБНЫЕ КОМАНДЫ СЕРВЕРА
 *  ---------------------------------------------------------------------------
 *  node server/cli.js status            состояние хранилища и справочников
 *  node server/cli.js token             показать/создать токен доступа
 *  node server/cli.js rotate-token      выпустить новый токен (старый перестанет работать)
 *  node server/cli.js revisions [N]     список ревизий data/state.js
 *  node server/cli.js restore <файл>    откатиться к ревизии (создаёт новую)
 *  node server/cli.js backup [файл]     выгрузить JSON-бэкап на диск
 *  node server/cli.js reminders         показать, что уйдёт в Telegram
 *  node server/cli.js send              отправить напоминания сейчас
 *  node server/cli.js validate          проверить data-слой (config.js)
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const store = require('./store');
const auth = require('./auth');
const configLoader = require('./config-loader');
const notify = require('./notify');

const [, , command, ...args] = process.argv;

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

function status() {
  store.ensureDirs();
  const { data } = store.load();
  const cfg = configLoader.status();
  console.log('🏠 ЖКУ · Крым — состояние сервера');
  console.log('  Файл данных        : data/state.js');
  console.log('  Ревизия            : ' + data.meta.revision + ' · обновлено ' + data.meta.updatedAt);
  console.log('  Записей журнала    : ' + fmt(data.journal.length));
  console.log('  Движений кошельков : ' + fmt(data.movements.length));
  console.log('  Объектов с правками: ' + Object.keys(data.objects).length);
  console.log('  Контрольная сумма  : ' + store.checksum(data));
  console.log('  История ревизий    : ' + store.revisions(1000).length + ' файлов (лимит ' + (process.env.ZHKX_HISTORY_LIMIT || 60) + ')');
  console.log('  Справочники        : ' + cfg.objects + ' объектов · тарифы ЭЭ: ' + cfg.electricityTariffs.join(', '));
  console.log('  Архивы водомеров   : ' + cfg.archiveRecords + ' записей');
  console.log('  config.js изменён  : ' + cfg.mtime);
  const v = configLoader.validate();
  console.log('  Валидация data-слоя: ' + (v.ok ? '✅ без замечаний' : '❌ ' + v.problems.join('; ')));
}

function reviseList(limit) {
  const list = store.revisions(limit || 20);
  if (!list.length) return console.log('Ревизий ещё нет.');
  console.log('Ревизии data/state.js (свежие сверху):');
  list.forEach(function (r) {
    console.log('  ' + r.file.padEnd(34) + ' rev ' + String(r.revision || '?').padStart(4) +
      ' · ' + (r.updatedAt || r.mtime) + ' · записей ' + (r.journal || 0) + ' · ' + Math.round((r.size || 0) / 1024) + ' КБ');
  });
}

function restore(file) {
  if (!file) throw new Error('Укажите файл ревизии: node server/cli.js restore state-00012-….js');
  const rev = store.readRevision(file);
  rev.data.meta.restoredFrom = rev.file;
  const saved = store.persist(rev.data, { reason: 'restore:' + rev.file, actor: 'cli' });
  console.log('✅ Восстановлено из ' + rev.file + ' → новая ревизия ' + saved.revision);
}

function backup(target) {
  const { data } = store.load();
  const payload = store.backupPayload(data, { file: 'data/state.js', time: new Date().toISOString() });
  const name = target || ('zhkx-server-backup-' + store.stamp() + '.json');
  fs.writeFileSync(path.resolve(name), JSON.stringify(payload, null, 2));
  console.log('💾 Бэкап сохранён: ' + name + ' (' + Math.round(fs.statSync(path.resolve(name)).size / 1024) + ' КБ)');
}

async function reminders() {
  const list = notify.reminders();
  console.log('Напоминания (' + list.length + '):\n');
  console.log(notify.toTelegramText(list));
  console.log('\nTelegram: ' + (notify.isConfigured() ? 'настроен — команда `send` отправит это сообщение' : 'не настроен (ZHKX_TELEGRAM_TOKEN / ZHKX_TELEGRAM_CHAT)'));
}

async function send() {
  const res = await notify.sendNow();
  if (res.skipped) console.log('⚠️  ' + res.reason + '\n\nТекст сообщения:\n' + res.text);
  else console.log(res.ok ? '✅ Отправлено (' + res.count + ' напоминаний)' : '❌ Ошибка отправки: ' + JSON.stringify(res.result));
}

function token(rotate) {
  const a = rotate ? auth.rotate() : auth.loadOrCreate();
  console.log((rotate ? '🔑 Новый токен: ' : '🔑 Токен доступа: ') + a.token);
  console.log('   Файл: data/auth.json' + (a.source === 'env' ? ' (переопределён ZHKX_TOKEN)' : ''));
  console.log('   Вход в приложение: откройте сервер и вставьте токен на экране входа.');
}

function validate() {
  const v = configLoader.validate();
  console.log(v.ok ? '✅ data-слой корректен' : '❌ Проблемы data-слоя:');
  v.problems.forEach(function (p) { console.log('   • ' + p); });
  const meters = configLoader.meters();
  const attention = meters.filter(function (m) { return m.status === 'expired' || m.status === 'warning'; });
  console.log('\nГосповерка: ' + meters.length + ' приборов, требуют внимания: ' + attention.length);
  attention.forEach(function (m) {
    console.log('   ' + (m.status === 'expired' ? '❌' : '⚠️') + ' №' + m.objectIndex + ' ' + m.objectLabel + ' · ' + m.serviceId +
      ' · до ' + m.nextCheckDate + ' (' + m.daysLeft + ' дн.)');
  });
}

async function main() {
  switch (command) {
    case 'status': return status();
    case 'token': return token(false);
    case 'rotate-token': return token(true);
    case 'revisions': return reviseList(Number(args[0]) || 20);
    case 'restore': return restore(args[0]);
    case 'backup': return backup(args[0]);
    case 'reminders': return reminders();
    case 'send': return send();
    case 'validate': return validate();
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('* ====')[1].split('=').join('').replace(/^\s*\*\s?/gm, '').trim());
  }
}

main().catch(function (e) {
  console.error('❌ ' + e.message);
  process.exitCode = 1;
});
