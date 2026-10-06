/* ============================================================================
 *  server/notify.js — НАПОМИНАНИЯ (Telegram) О ПОКАЗАНИЯХ, АВАНСАХ И ПОВЕРКАХ
 *  ---------------------------------------------------------------------------
 *  Сервер считает, о чём и когда стоит напомнить, опираясь на справочники
 *  (config-loader) и данные журнала (store):
 *
 *    • передача показаний — 20–25 число каждого месяца, по объектам, где
 *      нет записи за текущий период;
 *    • истекающая госповерка — за 30 и за 7 дней до срока;
 *    • заканчивающийся аванс — если остатка хватает менее чем на 1 месяц;
 *    • появившийся долг по услуге.
 *
 *  Отправка включается переменными окружения:
 *      ZHKX_TELEGRAM_TOKEN=<токен бота>
 *      ZHKX_TELEGRAM_CHAT=<chat_id>
 *  Без них сервер только формирует список напоминаний (GET /api/reminders)
 *  и пишет их в лог — удобно проверить перед подключением бота.
 * ==========================================================================*/
'use strict';

const store = require('./store');
const configLoader = require('./config-loader');

/* ------------------------------------------------------------------ расчёты */
function pad(n) { return String(n).padStart(2, '0'); }

function periodsBack(period, months) {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) - months;
  return Math.floor(total / 12) + '-' + pad((total % 12) + 1);
}

function monthLabel(period) {
  const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return period || '';
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

function money(v) {
  return Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}

function verifications(now) {
  const today = now || new Date();
  return configLoader.meters().filter(function (m) {
    if (m.daysLeft === null) return false;
    return m.daysLeft <= 30;
  }).map(function (m) {
    const label = m.status === 'expired'
      ? '❌ Поверка просрочена'
      : (m.daysLeft <= 7 ? '⚠️ Поверка на грани' : '⚠️ Скоро поверка');
    return {
      kind: 'verification',
      level: m.status === 'expired' ? 'danger' : 'warn',
      title: label + ': ' + m.objectLabel + ' · ' + (m.serviceId === 'electricity' ? 'электроэнергия' : 'вода'),
      text: 'Счётчик № ' + (m.serial || '—') + ' (' + (m.model || 'модель не указана') + '). ' +
        (m.status === 'expired'
          ? 'Срок поверки истёк: ' + m.nextCheckDate
          : 'Срок поверки ' + m.nextCheckDate + ' — осталось ' + m.daysLeft + ' дн.'),
      objectId: m.objectId,
      serviceId: m.serviceId,
      dueDate: m.nextCheckDate
    };
  });
}

function readingsReminders(state, now) {
  const date = now || new Date();
  const day = date.getDate();
  const period = date.getFullYear() + '-' + pad(date.getMonth() + 1);
  const inWindow = day >= 20 && day <= 25;
  const objects = configLoader.objects();

  const missing = objects.filter(function (o) {
    const has = state.journal.some(function (e) { return e.objectId === o.id && e.period === period; });
    return !has;
  });

  if (!missing.length) {
    return [{
      kind: 'readings',
      level: 'ok',
      title: 'Показания за ' + monthLabel(period) + ' внесены полностью',
      text: 'Все ' + objects.length + ' объектов закрыты начислениями за текущий период.',
      dueDate: null
    }];
  }

  const list = [{
    kind: 'readings',
    level: inWindow ? 'warn' : 'info',
    title: 'Передайте показания за ' + monthLabel(period) + ': не внесено по ' +
      missing.length + ' ' + plural(missing.length, 'объекту', 'объектам', 'объектам'),
    text: missing.map(function (o) { return '№' + o.index + ' ' + o.label + (o.services.electricity.account ? ' (Л/С ' + o.services.electricity.account + ')' : ''); }).join('; ') +
      (inWindow ? ' — сегодня ' + day + '-е число, самое время передать показания.' : ''),
    objectId: null,
    dueDate: period + '-25'
  }];
  return list;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function moneyReminders(state) {
  const out = [];
  const objects = configLoader.objects();
  const period = currentPeriod();

  objects.forEach(function (o) {
    /* Баланс = Σ движений по услуге (начисление хранится со знаком минус) */
    const balances = {};
    state.movements.filter(function (m) { return m.objectId === o.id; }).forEach(function (m) {
      balances[m.serviceId] = (balances[m.serviceId] || 0) + Number(m.amount || 0);
    });

    const expected = {
      maintenance: o.services.maintenanceRate * o.area,
      caprepair: o.services.capRepairRate * o.area,
      internet: o.services.internetEnabled ? o.services.internetRate : 0
    };

    Object.keys(balances).forEach(function (serviceId) {
      const bal = Math.round(balances[serviceId] * 100) / 100;
      if (bal < -0.5) {
        out.push({
          kind: 'debt',
          level: 'warn',
          title: 'Долг по объекту «' + o.label + '»: ' + serviceIdLabel(serviceId),
          text: 'Задолженность ' + money(Math.abs(bal)) + '. Внесите оплату или аванс.',
          objectId: o.id, serviceId: serviceId
        });
        return;
      }
      const monthly = expected[serviceId] || 0;
      if (bal > 0 && monthly > 0 && bal / monthly < 1) {
        out.push({
          kind: 'advance-low',
          level: 'info',
          title: 'Аванс почти исчерпан: ' + o.label + ' · ' + serviceIdLabel(serviceId),
          text: 'Осталось ' + money(bal) + ' — это меньше одного платежа (' + money(monthly) + '/мес). ' +
            'Пополните кошелёк, чтобы не уйти в долг.',
          objectId: o.id, serviceId: serviceId
        });
      }
      if (bal > 0 && monthly > 0 && bal / monthly >= 1 && bal / monthly < 2) {
        out.push({
          kind: 'advance-month',
          level: 'info',
          title: 'Аванса хватит примерно на месяц: ' + o.label + ' · ' + serviceIdLabel(serviceId),
          text: 'Остаток ' + money(bal) + ' при платеже ' + money(monthly) + '/мес.',
          objectId: o.id, serviceId: serviceId
        });
      }
    });
  });

  return out;
}

function currentPeriod(now) {
  const d = now || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1);
}

function serviceIdLabel(id) {
  return {
    maintenance: 'содержание МКД',
    caprepair: 'капитальный ремонт',
    electricity: 'электроэнергия',
    water: 'водоснабжение',
    internet: 'интернет'
  }[id] || id;
}

/** Полный список напоминаний на текущий момент */
function reminders(now) {
  const { data } = store.load();
  return []
    .concat(readingsReminders(data, now))
    .concat(verifications(now))
    .concat(moneyReminders(data));
}

/** Текст для Telegram (Markdown) */
function toTelegramText(list) {
  const head = '🏠 ЖКУ · Крым — напоминания на ' + new Date().toLocaleDateString('ru-RU');
  const icon = { danger: '❌', warn: '⚠️', info: 'ℹ️', ok: '✅' };
  const lines = list.filter(function (r) { return r.level !== 'ok'; }).map(function (r) {
    return (icon[r.level] || '•') + ' *' + r.title + '*\n' + r.text;
  });
  if (!lines.length) return head + '\n\n✅ Всё в порядке: начисления внесены, поверки в срок, долгов нет.';
  return head + '\n\n' + lines.join('\n\n');
}

/* ------------------------------------------------------------------ отправка */
function isConfigured() {
  return !!(process.env.ZHKX_TELEGRAM_TOKEN && process.env.ZHKX_TELEGRAM_CHAT);
}

async function sendText(text) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'Telegram не настроен (нет ZHKX_TELEGRAM_TOKEN / ZHKX_TELEGRAM_CHAT)' };
  const url = 'https://api.telegram.org/bot' + process.env.ZHKX_TELEGRAM_TOKEN + '/sendMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.ZHKX_TELEGRAM_CHAT, text, parse_mode: 'Markdown' })
  });
  const json = await res.json().catch(function () { return null; });
  return { ok: res.ok && json && json.ok !== false, status: res.status, response: json };
}

async function sendNow(now) {
  const list = reminders(now);
  const text = toTelegramText(list);
  const result = await sendText(text);
  return { ok: result.ok, skipped: !!result.skipped, reason: result.reason, count: list.length, text, result };
}

/**
 * Планировщик: раз в час проверяет, не пора ли отправить напоминание.
 * Отправляем один раз в день в 09:00–10:00 (МСК) и, если сегодня 20–25 число,
 * дополнительно напоминаем про показания в 18:00.
 */
function startScheduler(options) {
  const o = options || {};
  const log = o.log || console.log;
  let lastSentKey = null;

  async function tick() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDate();
    const key = now.toISOString().slice(0, 10) + '#' + hour;

    const morning = hour === 9;
    const eveningReadings = hour === 18 && day >= 20 && day <= 25;
    if (!morning && !eveningReadings) return;
    if (lastSentKey === key) return;
    lastSentKey = key;

    const list = reminders(now);
    const important = list.filter(function (r) { return r.level === 'danger' || r.level === 'warn'; });
    if (eveningReadings && !important.length && list.length) {
      /* вечером в окне показаний отправляем даже «информационные» */
    } else if (!important.length) {
      log('[notify] напоминаний, требующих внимания, нет');
      return;
    }

    const text = toTelegramText(list);
    const result = await sendText(text);
    if (result.skipped) log('[notify] ' + result.reason + '\n' + text.replace(/\*/g, ''));
    else log('[notify] отправлено: ' + (result.ok ? 'успешно' : 'ошибка ' + result.status));
  }

  const timer = setInterval(function () { tick().catch(function (e) { log('[notify] ошибка: ' + e.message); }); }, 30 * 60 * 1000);
  if (timer.unref) timer.unref();
  if (o.runOnStart) tick().catch(function () {});
  return { stop() { clearInterval(timer); }, tick };
}

module.exports = {
  reminders,
  verifications,
  readingsReminders,
  moneyReminders,
  toTelegramText,
  sendText,
  sendNow,
  startScheduler,
  isConfigured,
  currentPeriod,
  monthLabel
};
