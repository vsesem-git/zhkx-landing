/* ============================================================================
 *  server/auth.js — ДОСТУП К ДАННЫМ (токен + защита от перебора)
 *  ---------------------------------------------------------------------------
 *  Данные личные (ФИО, адреса, лицевые счета, показания), поэтому доступ к API
 *  защищён токеном. Варианты настройки:
 *
 *    ZHKX_TOKEN=<строка>        — использовать заданный токен (рекомендуется);
 *    ZHKX_DEMO_AUTH=1           — демо-режим песочницы: токен "demo-token"
 *                                 и подсказка на экране входа;
 *    (ничего не задано)         — токен генерируется при первом запуске
 *                                 и печатается в лог сервера; хранится в
 *                                 data/auth.json (файл в .gitignore).
 *
 *  Дополнительно: примитивный rate-limit — после 20 неудачных попыток с одного
 *  IP вход блокируется на 15 минут. Сравнение токенов — постоянное по времени.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* См. server/store.js: каталог данных переопределяется через ZHKX_DATA_DIR */
const DATA_DIR = process.env.ZHKX_DATA_DIR
  ? path.resolve(process.env.ZHKX_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const DEMO_TOKEN = 'demo-token';

let auth = null;
const failures = new Map(); // ip → { count, blockedUntil }

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadOrCreate() {
  if (auth) return auth;

  if (process.env.ZHKX_TOKEN) {
    auth = { token: String(process.env.ZHKX_TOKEN), demoAuth: false, source: 'env', createdAt: new Date().toISOString() };
    return auth;
  }

  if (process.env.ZHKX_DEMO_AUTH === '1') {
    auth = { token: DEMO_TOKEN, demoAuth: true, source: 'demo', createdAt: new Date().toISOString() };
    return auth;
  }

  ensureDirs();
  if (fs.existsSync(AUTH_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (parsed && parsed.token) {
        auth = Object.assign({ demoAuth: false, source: 'file' }, parsed);
        return auth;
      }
    } catch (e) {
      /* повреждённый файл — перевыпускаем токен */
    }
  }

  const token = crypto.randomBytes(24).toString('base64url');
  auth = { token, demoAuth: false, source: 'generated', createdAt: new Date().toISOString() };
  ensureDirs();
  fs.writeFileSync(AUTH_FILE, JSON.stringify({
    token,
    note: 'Токен доступа к API ЖКУ. Можно переопределить переменной ZHKX_TOKEN.',
    createdAt: auth.createdAt
  }, null, 2), { mode: 0o600 });
  return auth;
}

function info() {
  const a = loadOrCreate();
  return { authRequired: true, demoAuth: !!a.demoAuth, source: a.source };
}

function tokenFromRequest(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('token');
  return q ? q.trim() : null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function isBlocked(req) {
  const rec = failures.get(clientIp(req));
  if (!rec) return 0;
  if (rec.blockedUntil && rec.blockedUntil > Date.now()) return Math.ceil((rec.blockedUntil - Date.now()) / 1000);
  return 0;
}

function registerFailure(req) {
  const ip = clientIp(req);
  const rec = failures.get(ip) || { count: 0, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 20) { rec.blockedUntil = Date.now() + 15 * 60 * 1000; rec.count = 0; }
  failures.set(ip, rec);
  return rec;
}

function resetFailures(req) {
  failures.delete(clientIp(req));
}

/** Проверка запроса. Возвращает { ok } либо { ok:false, status, error } */
function check(req) {
  const blocked = isBlocked(req);
  if (blocked) return { ok: false, status: 429, error: 'Слишком много неудачных попыток. Повторите через ' + blocked + ' с.' };

  const provided = tokenFromRequest(req);
  if (!provided) return { ok: false, status: 401, error: 'Требуется токен доступа (Authorization: Bearer …)' };

  const a = loadOrCreate();
  if (!safeEqual(provided, a.token)) {
    const rec = registerFailure(req);
    return { ok: false, status: 401, error: 'Неверный токен доступа', remainingAttempts: Math.max(0, 20 - rec.count) };
  }
  resetFailures(req);
  return { ok: true };
}

/** Проверка «простого» токена из query (для загрузки state.js как скрипта) */
function checkToken(token) {
  const a = loadOrCreate();
  return !!token && safeEqual(token, a.token);
}

function rotate() {
  ensureDirs();
  const token = crypto.randomBytes(24).toString('base64url');
  auth = { token, demoAuth: false, source: 'generated', createdAt: new Date().toISOString() };
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ token, createdAt: auth.createdAt }, null, 2), { mode: 0o600 });
  return auth;
}

module.exports = { AUTH_FILE, DEMO_TOKEN, loadOrCreate, info, check, checkToken, tokenFromRequest, rotate, isBlocked };
