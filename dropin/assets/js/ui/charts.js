/* ============================================================================
 *  UI / CHARTS — фасад над Chart.js (с автопереключением на SimpleChart)
 *  ---------------------------------------------------------------------------
 *  Приложение вызывает Charts.render(canvasId, config) в любое время:
 *  фабрика сама создаёт, обновляет или пересоздаёт диаграмму под нужный движок.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var NS = global.ZHKX = global.ZHKX || {};
  var registry = {};
  var engine = 'pending';

  function isDark() {
    var theme = NS.State ? NS.State.getSetting('theme', 'dark') : 'dark';
    return theme !== 'light';
  }

  function themeColors() {
    var dark = isDark();
    return {
      text: dark ? '#e6edf6' : '#0f172a',
      dim: dark ? '#8b9bb4' : '#5b6b82',
      grid: dark ? 'rgba(148,163,184,0.16)' : 'rgba(15,23,42,0.10)',
      tooltipBg: dark ? 'rgba(12,17,26,0.95)' : 'rgba(255,255,255,0.97)'
    };
  }

  /** Применяет общую тему к конфигу Chart.js */
  function applyTheme(config) {
    var c = themeColors();
    var cfg = JSON.parse(JSON.stringify(config));
    cfg.options = cfg.options || {};
    var o = cfg.options;
    o.responsive = true;
    o.maintainAspectRatio = false;
    o.animation = { duration: 350 };
    o.color = c.text;
    o.plugins = o.plugins || {};
    o.plugins.tooltip = Object.assign({
      backgroundColor: c.tooltipBg,
      titleColor: c.text,
      bodyColor: c.text,
      borderColor: c.grid,
      borderWidth: 1,
      padding: 10,
      displayColors: cfg.type === 'doughnut'
    }, o.plugins.tooltip || {});
    if (cfg.type === 'doughnut' || cfg.type === 'pie') {
      o.plugins.legend = o.plugins.legend || { display: false };
      o.cutout = cfg.type === 'pie' ? 0 : '62%';
    } else {
      o.scales = o.scales || {};
      o.scales.x = Object.assign({ grid: { display: false, drawBorder: false }, ticks: { color: c.dim, maxRotation: 0, autoSkipPadding: 12 } }, o.scales.x || {});
      o.scales.y = Object.assign({
        grid: { color: c.grid, drawBorder: false },
        ticks: {
          color: c.dim,
          callback: function (value) { return Number(value).toLocaleString('ru-RU'); }
        },
        beginAtZero: true
      }, o.scales.y || {});
      o.plugins.legend = Object.assign({ display: false }, o.plugins.legend || {});
    }
    return cfg;
  }

  /**
   * Инициализация диаграмм. Ключевой приём: интерфейс не ждёт сеть — сразу
   * включается встроенный рендерер, а Chart.js подгружается в фоне и, если
   * доступен, «подхватывает» уже отрисованные диаграммы.
   */
  function init() {
    if (engine !== 'pending') return Promise.resolve(engine);

    function notify() {
      if (NS.App && NS.App.onChartEngineReady) NS.App.onChartEngineReady(engine);
    }

    if (global.Chart) {
      engine = 'chartjs';
      notify();
      return Promise.resolve(engine);
    }

    engine = 'simple';
    notify();
    return NS.ChartLoader.ensureChartJS().then(function (res) {
      engine = res.engine;
      notify();
      return engine;
    });
  }

  function getCanvas(canvasId) {
    if (typeof canvasId === 'string') return document.getElementById(canvasId);
    return canvasId;
  }

  /**
   * Отрисовать (создать/обновить) диаграмму.
   * @param {string|HTMLElement} canvasId
   * @param {object} config конфиг в формате Chart.js
   */
  function render(canvasId, config) {
    var canvas = getCanvas(canvasId);
    if (!canvas) return null;
    var key = canvas.id || canvasId;
    var themed = applyTheme(config);

    if (global.Chart) {
      /* Native Chart.js */
      var existing = registry[key];
      if (existing && existing.engine === 'chartjs' && existing.instance && !existing.instance.__destroyed) {
        try {
          existing.instance.data = themed.data;
          existing.instance.options = themed.options;
          existing.instance.config.type = themed.type;
          existing.instance.update('none');
          existing.config = config;
          return existing.instance;
        } catch (e) {
          try { existing.instance.destroy(); } catch (e2) { /* ignore */ }
        }
      }
      if (existing && existing.instance && existing.instance.destroy) {
        try { existing.instance.destroy(); } catch (e3) { /* ignore */ }
      }
      var chart = new global.Chart(canvas, themed);
      registry[key] = { engine: 'chartjs', instance: chart, config: config };
      return chart;
    }

    /* Встроенный рендерер */
    var entry = registry[key];
    if (entry && entry.engine === 'simple') {
      entry.instance.update(themed);
      entry.config = config;
      return entry.instance;
    }
    if (entry && entry.instance && entry.instance.destroy) {
      try { entry.instance.destroy(); } catch (e4) { /* ignore */ }
    }
    var simple = new NS.SimpleChart(canvas, themed);
    registry[key] = { engine: 'simple', instance: simple, config: config };
    return simple;
  }

  function destroy(canvasId) {
    var canvas = getCanvas(canvasId);
    var key = (canvas && canvas.id) || canvasId;
    var entry = registry[key];
    if (!entry) return;
    try { entry.instance.destroy(); } catch (e) { /* ignore */ }
    delete registry[key];
  }

  function destroyAll() {
    Object.keys(registry).forEach(function (key) {
      try { registry[key].instance.destroy(); } catch (e) { /* ignore */ }
      delete registry[key];
    });
  }

  /** Текущий движок: 'chartjs' | 'simple' | 'pending' */
  function currentEngine() { return engine; }
  function engineLabel() {
    return engine === 'chartjs' ? 'Chart.js (CDN)' : (engine === 'simple' ? 'встроенный canvas-рендерер' : 'инициализация…');
  }

  NS.Charts = {
    init: init,
    render: render,
    destroy: destroy,
    destroyAll: destroyAll,
    currentEngine: currentEngine,
    engineLabel: engineLabel,
    applyTheme: applyTheme
  };
})(typeof window !== 'undefined' ? window : globalThis);
