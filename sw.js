/* ============================================================================
 *  sw.js — SERVICE WORKER (офлайн-режим и установка на телефон)
 *  ---------------------------------------------------------------------------
 *  Стратегии:
 *    • навигация (index.html) — network-first: свежий код всегда важнее кэша,
 *      при отсутствии сети отдаём сохранённую копию приложения;
 *    • статика /assets/** — stale-while-revalidate: мгновенно из кэша,
 *      обновление в фоне;
 *    • /api/** и /data/** — НИКОГДА не кэшируются: данные всегда с сервера
 *      (офлайн-очередь изменений ведёт core/sync.js).
 *
 *  При каждом деплое меняйте APP_VERSION — кэш пересоберётся автоматически.
 * ==========================================================================*/
'use strict';

var APP_VERSION = '2.0.0';
var CACHE = 'zhkx-' + APP_VERSION;
var ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/css/styles.css',
  '/assets/js/data/config.js',
  '/assets/js/core/utils.js',
  '/assets/js/core/tariff-engine.js',
  '/assets/js/core/state.js',
  '/assets/js/core/analytics.js',
  '/assets/js/core/sync.js',
  '/assets/js/ui/vendor-chartjs.js',
  '/assets/js/ui/charts.js',
  '/assets/js/ui/views.js',
  '/assets/js/ui/forms.js',
  '/assets/js/ui/app.js',
  '/assets/icons/icon.svg',
  '/assets/icons/icon-maskable.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS.map(function (url) {
        return new Request(url, { cache: 'reload' });
      })).catch(function () { /* часть файлов может отсутствовать — не критично */ });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;          // сторонние ресурсы — как есть
  if (url.pathname.indexOf('/api/') === 0) return;          // API — только сеть
  if (url.pathname.indexOf('/data/') === 0) return;         // данные — только сеть

  /* Навигация: сеть → кэш */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put('/index.html', copy); });
        return response;
      }).catch(function () {
        return caches.match('/index.html').then(function (cached) {
          return cached || new Response('Приложение не закэшировано — подключитесь к сети.', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      })
    );
    return;
  }

  /* Статика: кэш → сеть (с фоновым обновлением) */
  if (url.pathname.indexOf('/assets/') === 0 || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(request).then(function (cached) {
        var network = fetch(request).then(function (response) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
          return response;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
  }
});
