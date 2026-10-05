/* ============================================================================
 *  UI / OFFLINE — офлайн-плашка и установка приложения (PWA)
 *  ---------------------------------------------------------------------------
 *  • Регистрирует service worker (офлайн-режим, установка на телефон).
 *  • Показывает плашку «нет сети»: изменения продолжают сохраняться локально
 *    и уйдут на сервер автоматически.
 *  • По клику на плашку можно отправить очередь на сервер вручную.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Sync = global.ZHKX && global.ZHKX.Sync;

  function render() {
    var bar = document.getElementById('offline-bar');
    if (!bar) return;
    var online = !global.navigator || global.navigator.onLine !== false;
    var info = Sync ? Sync.info() : null;

    if (online && (!info || info.status !== 'offline')) { bar.hidden = true; return; }

    var pending = info ? info.pending : 0;
    var text = !online
      ? '📴 Нет сети. Приложение работает офлайн'
      : '⚠️ Сервер недоступен — работаем на локальной копии';
    if (pending) text += ': в очереди ' + pending + ' ' + plural(pending);
    bar.hidden = false;
    bar.innerHTML = '<span>' + text + '</span>' +
      (pending ? '<button class="btn btn--ghost btn--sm" id="offline-flush">↻ Отправить на сервер</button>' : '');
    var btn = document.getElementById('offline-flush');
    if (btn) {
      btn.addEventListener('click', function () {
        if (Sync) Sync.flush().then(function () { render(); });
      });
    }
  }

  function plural(n) {
    var abs = Math.abs(n) % 100, last = abs % 10;
    if (abs > 10 && abs < 20) return 'изменений';
    if (last === 1) return 'изменение';
    if (last >= 2 && last <= 4) return 'изменения';
    return 'изменений';
  }

  global.addEventListener('online', render);
  global.addEventListener('offline', render);
  if (Sync) Sync.onStatusChange(render);
  document.addEventListener('DOMContentLoaded', render);
  setTimeout(render, 800);

  if ('serviceWorker' in global.navigator && (global.location.protocol === 'http:' || global.location.protocol === 'https:')) {
    global.addEventListener('load', function () {
      global.navigator.serviceWorker.register('sw.js').then(function (reg) {
        /* Новая версия приложения — сообщаем один раз */
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && global.navigator.serviceWorker.controller) {
              var bar = document.getElementById('offline-bar');
              if (!bar) return;
              bar.hidden = false;
              bar.innerHTML = '<span>🆕 Доступна новая версия приложения</span>' +
                '<button class="btn btn--ghost btn--sm" id="offline-reload">Обновить</button>';
              var reload = document.getElementById('offline-reload');
              if (reload) reload.addEventListener('click', function () { global.location.reload(); });
            }
          });
        });
      }).catch(function (e) {
        console.warn('[ZHKX] Service worker не зарегистрирован:', e.message);
      });
    });
  }

  var ns = global.ZHKX = global.ZHKX || {};
  ns.Offline = { refresh: render };
})(typeof window !== 'undefined' ? window : globalThis);
