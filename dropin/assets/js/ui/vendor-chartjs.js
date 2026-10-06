/* ============================================================================
 *  UI / VENDOR-CHARTJS — подключение Chart.js + автономный резервный движок
 *  ---------------------------------------------------------------------------
 *  Приложение работает офлайн и БЕЗ внешних зависимостей: если Chart.js удалось
 *  загрузить (CDN), используется он (как требует ТЗ); если нет — включается
 *  встроенный минимальный рендерер SimpleChart на чистом <canvas> с тем же
 *  публичным API для наших нужд (doughnut / bar / line).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var ChartNS = global.ZHKX = global.ZHKX || {};

  /* -------------------------------------------------- ВСТРОЕННЫЙ РЕНДЕРЕР */
  var PALETTE = ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#10b981', '#ef4444',
    '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#a855f7', '#0ea5e9'];

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch (e) { return fallback; }
  }

  function SimpleChart(canvas, config) {
    if (typeof canvas === 'string') canvas = document.getElementById(canvas);
    this.canvas = canvas;
    /* getContext может быть недоступен (старые браузеры, canvas отключён) */
    try {
      this.ctx = (canvas && typeof canvas.getContext === 'function') ? canvas.getContext('2d') : null;
    } catch (e) {
      this.ctx = null;
    }
    if (!this.ctx) { this.disabled = true; return; }
    this.config = config || {};
    this._onResize = this.resize.bind(this);
    this._onMove = null;
    this._hoverIndex = -1;
    global.addEventListener('resize', this._onResize);
    this.setupHover();
    this.resize();
  }

  SimpleChart.prototype.setupHover = function () {
    if (this.disabled) return;
    var self = this;
    var canvas = this.canvas;
    canvas.style.cursor = 'default';
    this._onMove = function (evt) {
      var rect = canvas.getBoundingClientRect();
      var x = evt.clientX - rect.left;
      var y = evt.clientY - rect.top;
      var idx = self.hitTest(x, y);
      if (idx !== self._hoverIndex) {
        self._hoverIndex = idx;
        canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
        self.render();
      }
    };
    this._onLeave = function () {
      if (self._hoverIndex !== -1) { self._hoverIndex = -1; self.render(); }
    };
    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);
  };

  SimpleChart.prototype.hitTest = function (x, y) {
    var t = this.config.type;
    var areas = this._hitAreas || [];
    if (t === 'doughnut') {
      var cx = this._cx, cy = this._cy;
      var dx = x - cx, dy = y - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < this._innerR || dist > this._outerR) return -1;
      var angle = Math.atan2(dy, dx);
      var norm = (angle + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
      var acc = 0;
      for (var i = 0; i < areas.length; i++) {
        acc += areas[i].share * 2 * Math.PI;
        if (norm <= acc) return i;
      }
      return -1;
    }
    for (var j = 0; j < areas.length; j++) {
      var a = areas[j];
      if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) return j;
    }
    return -1;
  };

  SimpleChart.prototype.resize = function () {
    if (this.disabled) return;
    var canvas = this.canvas;
    var parent = canvas.parentElement;
    var w = canvas.clientWidth || (parent ? parent.clientWidth : 300);
    var h = canvas.clientHeight || (parent ? parent.clientHeight : 200);
    var dpr = global.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
    this.render();
  };

  SimpleChart.prototype.update = function (config) {
    if (config) this.config = config;
    this.resize();
  };

  SimpleChart.prototype.destroy = function () {
    if (this.disabled) return;
    global.removeEventListener('resize', this._onResize);
    if (this._onMove) this.canvas.removeEventListener('mousemove', this._onMove);
    if (this._onLeave) this.canvas.removeEventListener('mouseleave', this._onLeave);
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.width || 0, this.height || 0);
  };

  SimpleChart.prototype.data = function () {
    var d = this.config.data || { labels: [], datasets: [] };
    return {
      labels: d.labels || [],
      datasets: (d.datasets || []).map(function (ds) {
        return {
          label: ds.label || '',
          data: ds.data || [],
          backgroundColor: ds.backgroundColor || PALETTE[0],
          borderColor: ds.borderColor || null,
          borderWidth: ds.borderWidth === undefined ? 2 : ds.borderWidth,
          fill: !!ds.fill
        };
      })
    };
  };

  SimpleChart.prototype.render = function () {
    if (!this.ctx) return;
    var ctx = this.ctx;
    var type = this.config.type || 'doughnut';
    ctx.clearRect(0, 0, this.width, this.height);
    if (type === 'doughnut' || type === 'pie') this.renderDoughnut(type === 'pie');
    else if (type === 'line') this.renderLine();
    else this.renderBar();
  };

  function fmt(value) {
    var n = Number(value) || 0;
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  }

  SimpleChart.prototype.renderDoughnut = function (isPie) {
    var ctx = this.ctx;
    var d = this.data();
    var series = d.datasets[0] ? d.datasets[0] : { data: [], backgroundColor: [] };
    var values = series.data.map(function (v) { return Math.max(0, Number(v) || 0); });
    var total = values.reduce(function (a, b) { return a + b; }, 0);
    var cx = this.width / 2;
    var cy = this.height / 2;
    var radius = Math.max(20, Math.min(this.width, this.height) / 2 - 8);
    var inner = isPie ? 0 : Math.max(10, radius * 0.62);
    var colors = Array.isArray(series.backgroundColor) ? series.backgroundColor : [series.backgroundColor];

    this._cx = cx; this._cy = cy; this._innerR = inner; this._outerR = radius;

    if (total <= 0) {
      ctx.strokeStyle = cssVar('--border', '#243044');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = cssVar('--text-dim', '#8b9bb4');
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Нет данных за период', cx, cy);
      this._hitAreas = [];
      return;
    }

    var start = -Math.PI / 2;
    var areas = [];
    values.forEach(function (v, i) {
      if (v <= 0) { areas.push({ share: 0 }); return; }
      var share = v / total;
      var end = start + share * Math.PI * 2;
      var lift = (this._hoverIndex === i) ? 4 : 0;
      var mid = (start + end) / 2;
      var ox = Math.cos(mid) * lift;
      var oy = Math.sin(mid) * lift;
      ctx.beginPath();
      ctx.moveTo(cx + ox, cy + oy);
      ctx.arc(cx + ox, cy + oy, radius, start, end);
      if (inner > 0) ctx.arc(cx + ox, cy + oy, inner, end, start, true);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length] || PALETTE[i % PALETTE.length];
      ctx.fill();
      ctx.strokeStyle = cssVar('--bg-card', '#161b22');
      ctx.lineWidth = 2;
      ctx.stroke();
      areas.push({ share: share, value: v, color: colors[i % colors.length], label: d.labels[i] || '' });
      start = end;
    }.bind(this));
    this._hitAreas = areas;

    /* Подпись в центре: сумма или наведённое значение */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var hovered = this._hoverIndex >= 0 ? areas[this._hoverIndex] : null;
    ctx.fillStyle = cssVar('--text-dim', '#8b9bb4');
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(hovered ? String(hovered.label).slice(0, 22) : 'Всего за период', cx, cy - 10);
    ctx.fillStyle = cssVar('--text', '#e6edf6');
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(fmt(hovered ? hovered.value : total) + ' ₽', cx, cy + 9);
  };

  SimpleChart.prototype.renderBar = function () {
    var ctx = this.ctx;
    var d = this.data();
    var datasets = d.datasets;
    var labels = d.labels;
    var padL = 56, padR = 12, padT = 14, padB = 30;
    var w = this.width - padL - padR;
    var h = this.height - padT - padB;
    if (w <= 10 || h <= 10) return;

    var max = 0;
    datasets.forEach(function (ds) {
      ds.data.forEach(function (v) { max = Math.max(max, Number(v) || 0); });
    });
    /* сетка для накопленных столбцов: считаем суммы по индексу */
    if (datasets.length > 1) {
      max = 0;
      labels.forEach(function (_, i) {
        var sum = datasets.reduce(function (acc, ds) { return acc + (Number(ds.data[i]) || 0); }, 0);
        max = Math.max(max, sum);
      });
    }
    var niceMax = max <= 0 ? 100 : Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) * Math.pow(10, Math.floor(Math.log10(max)));
    if (niceMax < max) niceMax = max * 1.1;

    var gridColor = cssVar('--border', '#243044');
    var dim = cssVar('--text-dim', '#8b9bb4');
    ctx.font = '11px system-ui, sans-serif';

    /* горизонтальная сетка */
    for (var g = 0; g <= 4; g++) {
      var y = padT + h - (h * g / 4);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
      ctx.fillStyle = dim;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmt(niceMax * g / 4), padL - 6, y);
    }

    var group = w / Math.max(1, labels.length);
    var barW = Math.max(4, Math.min(28, group * 0.62 / Math.max(1, datasets.length)));
    var areas = [];

    labels.forEach(function (label, i) {
      var x0 = padL + group * i + (group - barW * datasets.length) / 2;
      var accBase = 0;
      datasets.forEach(function (ds, di) {
        var value = Math.max(0, Number(ds.data[i]) || 0);
        var barH = niceMax > 0 ? (value / niceMax) * h : 0;
        var x = x0 + di * barW;
        var y = padT + h - accBase - barH;
        if (barH > 0.5) {
          ctx.fillStyle = ds.backgroundColor || PALETTE[di % PALETTE.length];
          ctx.globalAlpha = (this._hoverIndex === i) ? 1 : 0.9;
          var r = Math.min(3, barW / 2);
          roundRect(ctx, x, y, Math.max(2, barW - 2), barH, r);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        areas.push({ x: x, w: Math.max(2, barW - 2), y: Math.min(y, padT + h), h: Math.max(barH, 6), value: value, label: label, dataset: ds.label, color: ds.backgroundColor });
        accBase += barH;
      }.bind(this));

      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (labels.length <= 14) ctx.fillText(String(label), padL + group * i + group / 2, padT + h + 8);
    });

    this._hitAreas = areas;

    /* всплывающая подсказка */
    if (this._hoverIndex >= 0) {
      var hits = areas.filter(function (a) { return a.label === labels[this._hoverIndex]; }, this);
      if (hits.length) {
        var total = hits.reduce(function (acc, a2) { return acc + a2.value; }, 0);
        var text = labels[this._hoverIndex] + ': ' + fmt(total) + ' ₽';
        ctx.font = 'bold 11px system-ui, sans-serif';
        var tw = ctx.measureText(text).width + 14;
        var tx = Math.min(Math.max(padL, hits[0].x + hits[0].w / 2 - tw / 2), this.width - tw - 2);
        ctx.fillStyle = 'rgba(10,14,22,0.92)';
        roundRect(ctx, tx, 2, tw, 20, 5);
        ctx.fill();
        ctx.fillStyle = cssVar('--text', '#e6edf6');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, tx + 7, 13);
      }
    }

    if (labels.length > 14) {
      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(labels.length + ' периодов', padL + w / 2, padT + h + 8);
    }
  };

  SimpleChart.prototype.renderLine = function () {
    var ctx = this.ctx;
    var d = this.data();
    var ds = d.datasets[0] || { data: [], backgroundColor: PALETTE[0] };
    var values = (ds.data || []).map(function (v) { return Number(v) || 0; });
    var labels = d.labels || [];
    var padL = 56, padR = 12, padT = 14, padB = 30;
    var w = this.width - padL - padR;
    var h = this.height - padT - padB;
    if (w <= 10 || h <= 10 || !values.length) return;

    var max = Math.max.apply(null, values.concat([0]));
    var niceMax = max <= 0 ? 100 : Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) * Math.pow(10, Math.floor(Math.log10(max)));
    var gridColor = cssVar('--border', '#243044');
    var dim = cssVar('--text-dim', '#8b9bb4');
    var accent = ds.borderColor || ds.backgroundColor || PALETTE[0];
    ctx.font = '11px system-ui, sans-serif';

    for (var g = 0; g <= 4; g++) {
      var y = padT + h - (h * g / 4);
      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
      ctx.fillStyle = dim;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmt(niceMax * g / 4), padL - 6, y);
    }

    var step = values.length > 1 ? w / (values.length - 1) : 0;
    var points = values.map(function (v, i) {
      return { x: padL + step * i + (values.length === 1 ? w / 2 : 0), y: padT + h - (v / niceMax) * h, value: v };
    });

    /* заливка */
    var gradient = ctx.createLinearGradient(0, padT, 0, padT + h);
    gradient.addColorStop(0, hexToRgba(accent, 0.32));
    gradient.addColorStop(1, hexToRgba(accent, 0.02));
    ctx.beginPath();
    ctx.moveTo(points[0].x, padT + h);
    points.forEach(function (p) { ctx.lineTo(p.x, p.y); });
    ctx.lineTo(points[points.length - 1].x, padT + h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    /* линия */
    ctx.beginPath();
    points.forEach(function (p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    /* точки */
    points.forEach(function (p, i) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, this._hoverIndex === i ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.strokeStyle = cssVar('--bg-card', '#161b22');
      ctx.lineWidth = 2;
      ctx.stroke();
    }.bind(this));

    labels.forEach(function (label, i) {
      if (values.length > 14 && i % 2 !== 0) return;
      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(label), points[i].x, padT + h + 8);
    });

    this._hitAreas = points.map(function (p) {
      return { x: p.x - step / 2, w: Math.max(step, 10), y: padT, h: h, value: p.value };
    });

    if (this._hoverIndex >= 0 && this._hoverIndex < values.length) {
      var text = (labels[this._hoverIndex] || '') + ': ' + fmt(values[this._hoverIndex]) + ' ₽';
      ctx.font = 'bold 11px system-ui, sans-serif';
      var tw = ctx.measureText(text).width + 14;
      var tx = Math.min(Math.max(padL, points[this._hoverIndex].x - tw / 2), this.width - tw - 2);
      ctx.fillStyle = 'rgba(10,14,22,0.92)';
      roundRect(ctx, tx, 2, tw, 20, 5);
      ctx.fill();
      ctx.fillStyle = cssVar('--text', '#e6edf6');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, tx + 7, 13);
    }
  };

  function roundRect(ctx, x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function hexToRgba(hex, alpha) {
    var h = String(hex || '#3b82f6').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var num = parseInt(h, 16);
    var r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /* ------------------------------------------------------- ЗАГРУЗКА CDN -- */
  var CDN_SOURCES = [
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
    'https://unpkg.com/chart.js@4.4.1/dist/chart.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
  ];

  function loadScript(src, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; s.remove(); reject(new Error('timeout ' + src)); }
      }, timeoutMs || 7000);
      s.src = src;
      s.async = true;
      s.onload = function () { if (!done) { done = true; clearTimeout(timer); resolve(src); } };
      s.onerror = function () { if (!done) { done = true; clearTimeout(timer); s.remove(); reject(new Error('error ' + src)); } };
      document.head.appendChild(s);
    });
  }

  var enginePromise = null;

  function ensureChartJS() {
    if (global.Chart) return Promise.resolve({ engine: 'chartjs', native: true });
    if (enginePromise) return enginePromise;
    enginePromise = new Promise(function (resolve) {
      var i = 0;
      function attempt() {
        if (i >= CDN_SOURCES.length) {
          resolve({ engine: 'simple', native: false });
          return;
        }
        var src = CDN_SOURCES[i++];
        loadScript(src, 6000).then(function () {
          resolve(global.Chart ? { engine: 'chartjs', native: true } : { engine: 'simple', native: false });
        }).catch(function () { attempt(); });
      }
      attempt();
    });
    return enginePromise;
  }

  ChartNS.SimpleChart = SimpleChart;
  ChartNS.ChartLoader = {
    CDN_SOURCES: CDN_SOURCES,
    ensureChartJS: ensureChartJS,
    isNative: function () { return !!global.Chart; },
    palette: PALETTE
  };
})(typeof window !== 'undefined' ? window : globalThis);
