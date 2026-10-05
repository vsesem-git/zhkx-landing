/* ============================================================================
 *  CORE / UTILS — чистые утилиты (без DOM и без localStorage)
 *  ---------------------------------------------------------------------------
 *  Работа с деньгами, объёмами, датами (периоды ГГГГ-ММ) и форматированием
 *  по правилам русского языка. Все функции детерминированы и тестируемы.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MSK_MONTHS = [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'
  ];
  var MSK_MONTHS_GEN = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];

  /* -------------------------------------------------------------- ЧИСЛА -- */
  function toNumber(value, fallback) {
    if (typeof value === 'number') return isFinite(value) ? value : (fallback || 0);
    if (value === null || value === undefined || value === '') return fallback || 0;
    var normalized = String(value).trim().replace(/\s+/g, '').replace(',', '.');
    var n = parseFloat(normalized);
    return isFinite(n) ? n : (fallback || 0);
  }

  function isNumericLike(value) {
    if (value === null || value === undefined || value === '') return false;
    return isFinite(toNumber(value, NaN));
  }

  function round(value, decimals) {
    var d = typeof decimals === 'number' ? decimals : 2;
    var factor = Math.pow(10, d);
    return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
  }

  function clamp(value, min, max) {
    var v = toNumber(value);
    return Math.min(Math.max(v, min), max);
  }

  function sum(array, pick) {
    return (array || []).reduce(function (acc, item) {
      return acc + toNumber(pick ? pick(item) : item);
    }, 0);
  }

  /* ----------------------------------------------------- ФОРМАТИРОВАНИЕ -- */
  function formatMoney(value, opts) {
    var o = opts || {};
    var decimals = typeof o.decimals === 'number' ? o.decimals : 2;
    var n = toNumber(value);
    var text = n.toLocaleString('ru-RU', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
    return o.bare ? text : text + ' ₽';
  }

  function formatNumber(value, decimals) {
    return toNumber(value).toLocaleString('ru-RU', {
      minimumFractionDigits: typeof decimals === 'number' ? decimals : 2,
      maximumFractionDigits: typeof decimals === 'number' ? decimals : 2
    });
  }

  function formatRate(value, decimals) {
    var d = typeof decimals === 'number' ? decimals : 2;
    return formatNumber(value, d) + ' ₽';
  }

  function formatPercent(value, decimals) {
    return formatNumber(value, typeof decimals === 'number' ? decimals : 1) + '%';
  }

  /* ----------------------------------------------------- ДАТЫ И ПЕРИОДЫ -- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** '2026-10' → { year: 2026, month: 10 } */
  function parsePeriod(period) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
    if (!m) return null;
    var month = parseInt(m[2], 10);
    if (month < 1 || month > 12) return null;
    return { year: parseInt(m[1], 10), month: month };
  }

  /** { year, month } → '2026-10' */
  function makePeriod(year, month) {
    return String(year) + '-' + pad2(month);
  }

  /** Текущий календарный период компьютера: '2026-10' */
  function currentPeriod(date) {
    var d = date ? new Date(date) : new Date();
    return makePeriod(d.getFullYear(), d.getMonth() + 1);
  }

  /** Сдвиг периода на delta месяцев: addMonths('2026-10', 3) → '2027-01' */
  function addMonths(period, delta) {
    var p = parsePeriod(period);
    if (!p) return period;
    var total = (p.year * 12 + (p.month - 1)) + delta;
    return makePeriod(Math.floor(total / 12), (total % 12) + 1);
  }

  /** Сколько месяцев между периодами (b − a) */
  function monthsBetween(a, b) {
    var pa = parsePeriod(a);
    var pb = parsePeriod(b);
    if (!pa || !pb) return 0;
    return (pb.year * 12 + pb.month) - (pa.year * 12 + pa.month);
  }

  /** '2026-10' → 'Октябрь 2026' */
  function periodLabel(period) {
    var p = parsePeriod(period);
    if (!p) return String(period || '—');
    var name = MSK_MONTHS[p.month - 1];
    return name.charAt(0).toUpperCase() + name.slice(1) + ' ' + p.year;
  }

  /** '2026-10' → 'октябрь 2026' */
  function periodLabelLower(period) {
    var p = parsePeriod(period);
    if (!p) return String(period || '—');
    return MSK_MONTHS[p.month - 1] + ' ' + p.year;
  }

  /** '2026-10' → 'окт. 2026' */
  function periodLabelShort(period) {
    var p = parsePeriod(period);
    if (!p) return String(period || '—');
    return MSK_MONTHS[p.month - 1].slice(0, 3) + '. ' + p.year;
  }

  /** '2027-06-15' → '15 июня 2027 г.' */
  function formatDateISO(iso) {
    if (!iso) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return String(iso);
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    return d + ' ' + MSK_MONTHS_GEN[mo - 1] + ' ' + y + ' г.';
  }

  /** '2027-06-15' → '15.06.2027' */
  function formatDateDot(iso) {
    if (!iso) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return String(iso);
    return m[3] + '.' + m[2] + '.' + m[1];
  }

  function isoOf(date) {
    var d = (date instanceof Date) ? date : new Date(date);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseISO(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  /** Прибавить годы к ISO-дате (госповерка: checkDate + periodYears) */
  function addYearsISO(iso, years) {
    var d = parseISO(iso);
    if (!d) return null;
    var y = d.getFullYear() + toNumber(years);
    var m = d.getMonth();
    var day = d.getDate();
    /* 29.02 → 28.02 в невисокосный год */
    var probe = new Date(y, m, day);
    if (probe.getMonth() !== m) probe = new Date(y, m + 1, 0);
    return isoOf(probe);
  }

  /** Разница в целых днях: b − a (по календарным суткам) */
  function daysBetween(aISO, bISO) {
    var a = parseISO(typeof aISO === 'string' ? aISO : isoOf(aISO));
    var b = parseISO(typeof bISO === 'string' ? bISO : isoOf(bISO));
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }

  function todayISO(now) { return isoOf(now || new Date()); }

  /** Период, в который попадает дата, + смещение в месяцах → 'YYYY-MM' */
  function periodOfDate(dateISO) {
    var d = parseISO(dateISO);
    if (!d) return null;
    return makePeriod(d.getFullYear(), d.getMonth() + 1);
  }

  /** Последний день месяца периода '2026-02' → '2026-02-28' */
  function periodEndISO(period) {
    var p = parsePeriod(period);
    if (!p) return null;
    var last = new Date(p.year, p.month, 0);
    return isoOf(last);
  }

  /* -------------------------------------------------------------- СТРОКИ -- */
  function plural(n, one, few, many) {
    var abs = Math.abs(Math.floor(toNumber(n)));
    var mod10 = abs % 10;
    var mod100 = abs % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normalizeText(value) {
    return String(value === null || value === undefined ? '' : value)
      .toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  function uid(prefix) {
    var stamp = Date.now().toString(36);
    var rand = Math.random().toString(36).slice(2, 8);
    return (prefix || 'id') + '-' + stamp + '-' + rand;
  }

  function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (e) { /* fallback ниже */ }
    }
    return JSON.parse(JSON.stringify(value));
  }

  /** Скачивание текстового файла средствами браузера */
  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /** Чтение файла пользователя как текста (Promise) */
  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('Не удалось прочитать файл')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  var Utils = {
    MSK_MONTHS: MSK_MONTHS,
    MSK_MONTHS_GEN: MSK_MONTHS_GEN,
    toNumber: toNumber,
    isNumericLike: isNumericLike,
    round: round,
    clamp: clamp,
    sum: sum,
    formatMoney: formatMoney,
    formatNumber: formatNumber,
    formatRate: formatRate,
    formatPercent: formatPercent,
    pad2: pad2,
    parsePeriod: parsePeriod,
    makePeriod: makePeriod,
    currentPeriod: currentPeriod,
    addMonths: addMonths,
    monthsBetween: monthsBetween,
    periodLabel: periodLabel,
    periodLabelLower: periodLabelLower,
    periodLabelShort: periodLabelShort,
    formatDateISO: formatDateISO,
    formatDateDot: formatDateDot,
    isoOf: isoOf,
    parseISO: parseISO,
    addYearsISO: addYearsISO,
    daysBetween: daysBetween,
    todayISO: todayISO,
    periodOfDate: periodOfDate,
    periodEndISO: periodEndISO,
    plural: plural,
    escapeHtml: escapeHtml,
    normalizeText: normalizeText,
    uid: uid,
    deepClone: deepClone,
    downloadFile: downloadFile,
    readFileAsText: readFileAsText
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.Utils = Utils;
  if (typeof module !== 'undefined' && module.exports) module.exports = Utils;
})(typeof window !== 'undefined' ? window : globalThis);
