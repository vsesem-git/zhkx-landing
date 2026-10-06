/* ============================================================================
 *  CORE / TARIFF-ENGINE — расчётный движок (чистая логика, без DOM)
 *  ---------------------------------------------------------------------------
 *  Содержит расчёт:
 *    • электроэнергии по КУМУЛЯТИВНЫМ ступенчатым тарифным сеткам
 *      (в т.ч. параллельно по зонам День/Ночь с независимыми лимитами);
 *    • водоснабжения (объём × тариф ГУП РК «Вода Крыма»);
 *    • «Содержание МКД» и «Капитальный ремонт» (площадь × тариф);
 *    • интернета (фиксированная абонентская плата);
 *    • прогноза расхода авансового кошелька и времени до следующей госповерки.
 *
 *  Все функции получают «эффективный объект» (данные data-слоя + пользовательские
 *  правки) и не обращаются к DOM. Формат денег — 2 знака, объёмов — 3 знака.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Data = global.ZHKX && global.ZHKX.Data;
  var U = global.ZHKX && global.ZHKX.Utils;

  function requireDeps() {
    Data = Data || global.ZHKX.Data;
    U = U || global.ZHKX.Utils;
    if (!Data || !U) throw new Error('TariffEngine: не загружены data/config.js и core/utils.js');
    return { Data: Data, U: U };
  }

  /* ===================================================== ЭЛЕКТРОЭНЕРГИЯ === */
  /**
   * Разбор объёма потребления по кумулятивным ступеням (прогрессивная шкала).
   *
   * consumption = 900 кВтч, steps = [250@4.33, 800@5.45, ∞@9.20]:
   *   250 × 4.33 + 550 × 5.45 + 100 × 9.20 = 1082.50 + 2997.50 + 920.00 = 5000.00 ₽
   *
   * @param {number} consumption объём кВтч (≥ 0)
   * @param {Array}  steps       ступени из data-слоя
   * @param {string} [mode]      'progressive' (по умолчанию) | 'flat_bracket'
   * @returns {{consumption:number, total:number, averageRate:number, rows:Array}}
   */
  function breakdownBySteps(consumption, steps, mode) {
    requireDeps();
    var volume = Math.max(0, U.toNumber(consumption));
    var list = (steps || []).slice();
    var rows = [];
    var total = 0;
    var left = volume;
    var lower = 0;
    var strategy = mode || 'progressive';

    /* Непрогрессивный режим: вся ставка берётся из ступени, в которую попал объём */
    if (strategy === 'flat_bracket') {
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].upTo === null || volume <= list[i].upTo) { hit = list[i]; break; }
      }
      if (!hit && list.length) hit = list[list.length - 1];
      var flatCost = hit ? volume * hit.rate : 0;
      if (volume > 0 && hit) {
        rows.push({
          title: hit.title,
          rangeLabel: 'ставка по ступени',
          volume: volume,
          rate: hit.rate,
          cost: U.round(flatCost, Data.RULES.moneyDecimals)
        });
      }
      return {
        consumption: U.round(volume, Data.RULES.volumeDecimals),
        total: U.round(flatCost, Data.RULES.moneyDecimals),
        averageRate: volume > 0 ? flatCost / volume : 0,
        rows: rows
      };
    }

    for (var s = 0; s < list.length; s++) {
      var step = list[s];
      var upper = step.upTo === null || step.upTo === undefined ? Infinity : U.toNumber(step.upTo);
      var capacity = upper === Infinity ? Infinity : Math.max(0, upper - lower);
      var inStep = Math.min(left, capacity);
      if (left > 0 && inStep > 0) {
        var cost = inStep * step.rate;
        total += cost;
        rows.push({
          title: step.title,
          rangeLabel: (U.formatNumber(lower, 0) + '–' + (upper === Infinity ? '∞' : U.formatNumber(upper, 0)) + ' кВтч'),
          volume: U.round(inStep, Data.RULES.volumeDecimals),
          rate: step.rate,
          cost: U.round(cost, Data.RULES.moneyDecimals)
        });
        left -= inStep;
      }
      lower = upper;
      if (left <= 0) break;
    }

    return {
      consumption: U.round(volume, Data.RULES.volumeDecimals),
      total: U.round(total, Data.RULES.moneyDecimals),
      averageRate: volume > 0 ? total / volume : 0,
      rows: rows
    };
  }

  /** Достаёт шкалу (single/day/night) тарифной сетки электроэнергии */
  function getElectricityScale(categoryId, scaleId) {
    requireDeps();
    var cat = Data.ELECTRICITY_TARIFFS[categoryId];
    if (!cat) return null;
    return cat.scales[scaleId] || null;
  }

  /** Список шкал, применимых для объекта (по числу тарифных зон счётчика) */
  function scalesForObject(effectiveObj) {
    var el = effectiveObj.services.electricity;
    var cat = Data.ELECTRICITY_TARIFFS[el.category];
    if (!cat) return [];
    if (U.toNumber(el.zones, 1) >= 2) {
      return ['day', 'night'].filter(function (z) { return !!cat.scales[z]; });
    }
    return ['single'].filter(function (z) { return !!cat.scales[z]; });
  }

  /**
   * Начисление за электроэнергию за период.
   * @param {object} effectiveObj эффективный объект
   * @param {object} readings     { day, night } или { total }
   * @param {object} previous     предыдущие показания (та же структура)
   * @returns {{mode:string, category:object, zones:Array, total:number,
   *            consumption:number, averageRate:number}}
   */
  function electricityBill(effectiveObj, readings, previous) {
    requireDeps();
    var el = effectiveObj.services.electricity;
    var category = Data.ELECTRICITY_TARIFFS[el.category];
    var cur = readings || {};
    var prev = previous || {};
    var zoneIds = scalesForObject(effectiveObj);
    var zones = [];
    var grand = 0;
    var totalVolume = 0;

    zoneIds.forEach(function (zoneId) {
      var scale = category.scales[zoneId];
      var curValue = U.toNumber(zoneId === 'single' ? cur.total : cur[zoneId]);
      var prevValue = U.toNumber(zoneId === 'single' ? prev.total : prev[zoneId]);
      var consumption = Math.max(0, curValue - prevValue);
      var breakdown = breakdownBySteps(consumption, scale.steps, category.mode);
      grand += breakdown.total;
      totalVolume += breakdown.consumption;
      zones.push({
        id: zoneId,
        label: scale.label,
        hours: scale.hours,
        previous: prevValue,
        current: curValue,
        consumption: breakdown.consumption,
        total: breakdown.total,
        averageRate: breakdown.averageRate,
        rows: breakdown.rows
      });
    });

    return {
      mode: zoneIds.length > 1 ? 'day_night' : 'single',
      category: category,
      categoryLabel: category.label,
      zones: zones,
      consumption: U.round(totalVolume, Data.RULES.volumeDecimals),
      total: U.round(grand, Data.RULES.moneyDecimals),
      averageRate: totalVolume > 0 ? grand / totalVolume : 0
    };
  }

  /* ================================================== ВОДОСНАБЖЕНИЕ ====== */
  /**
   * Селектор периодов: какой тариф воды действует в указанном месяце.
   * График — массив { fromPeriod, rateKey } (последняя запись, у которой
   * fromPeriod ≤ period, и есть действующий тариф).
   * @param {object} effectiveObj объект
   * @param {string} period       'YYYY-MM'
   * @param {Array}  [schedule]   график объекта (по умолчанию — базовый из data-слоя)
   * @returns {{rateKey:string, fromPeriod:string|null, tariff:object, source:string}}
   */
  function resolveWaterRateKey(effectiveObj, period, schedule) {
    requireDeps();
    var rows = (schedule && schedule.length ? schedule : Data.WATER_TARIFF_SCHEDULE_DEFAULT)
      .filter(function (r) { return r && r.rateKey && r.fromPeriod; })
      .slice()
      .sort(function (a, b) { return String(a.fromPeriod).localeCompare(String(b.fromPeriod)); });

    var chosen = null;
    rows.forEach(function (row) {
      if (!period || String(row.fromPeriod) <= String(period)) chosen = row;
    });
    if (!chosen) chosen = rows[0] || null;

    var objKey = effectiveObj && effectiveObj.services && effectiveObj.services.water
      ? effectiveObj.services.water.rateKey : null;
    var key = (chosen && chosen.rateKey) || objKey || Data.WATER_DEFAULT_RATE_KEY;
    var tariff = Data.WATER_TARIFFS[key] || Data.WATER_TARIFFS[Data.WATER_DEFAULT_RATE_KEY];

    return {
      rateKey: tariff.id,
      fromPeriod: chosen ? chosen.fromPeriod : null,
      tariff: tariff,
      rate: tariff.rate,
      label: tariff.label,
      source: chosen ? 'schedule' : 'object'
    };
  }

  /** Начисление за воду: объём м³ × тариф выбранного варианта */
  function waterBill(volume, rateKey) {
    requireDeps();
    var key = rateKey || Data.WATER_DEFAULT_RATE_KEY;
    var tariff = Data.WATER_TARIFFS[key] || Data.WATER_TARIFFS[Data.WATER_DEFAULT_RATE_KEY];
    var v = Math.max(0, U.toNumber(volume));
    return {
      volume: U.round(v, Data.RULES.volumeDecimals),
      rate: tariff.rate,
      rateKey: tariff.id,
      rateLabel: tariff.label,
      total: U.round(v * tariff.rate, Data.RULES.moneyDecimals)
    };
  }

  /**
   * Статистика исторического архива водомера (показания + фактический расход).
   * Архив из data-слоя нужен для расчёта среднего расхода, пока в журнале
   * начислений ещё мало данных.
   * @param {Array} archive  [{ period, reading, consumption }]
   * @param {number} [window] окно усреднения (по умолчанию — 3 записи, как в ТЗ)
   */
  function archiveStats(archive, window) {
    requireDeps();
    var w = U.toNumber(window, Data.RULES.forecastWindowMonths) || 3;
    var records = (archive || [])
      .filter(function (r) { return r && U.parsePeriod(r.period); })
      .slice()
      .sort(function (a, b) { return String(a.period).localeCompare(String(b.period)); });

    if (!records.length) {
      return {
        count: 0, records: [], windowVolumes: [], average: 0, samples: 0,
        firstPeriod: null, lastPeriod: null, lastReading: null, lastConsumption: null,
        totalConsumption: 0, months: 0, averageAll: 0
      };
    }

    var windowRecords = records.slice(-w);
    var windowVolumes = windowRecords.map(function (r) { return U.toNumber(r.consumption); });
    var allVolumes = records.map(function (r) { return U.toNumber(r.consumption); });
    var last = records[records.length - 1];

    return {
      count: records.length,
      records: records,
      windowRecords: windowRecords,
      windowVolumes: windowVolumes,
      samples: windowVolumes.length,
      months: windowVolumes.length,
      average: U.round(U.sum(windowVolumes) / windowVolumes.length, Data.RULES.volumeDecimals),
      averageAll: U.round(U.sum(allVolumes) / allVolumes.length, Data.RULES.volumeDecimals),
      totalConsumption: U.round(U.sum(allVolumes), Data.RULES.volumeDecimals),
      firstPeriod: records[0].period,
      lastPeriod: last.period,
      lastReading: U.toNumber(last.reading),
      lastConsumption: U.toNumber(last.consumption)
    };
  }

  /**
   * Единый ряд потребления по услуге: журнал начислений + архив водомера
   * (архив подмешивается только по тем периодам, которых нет в журнале).
   * @returns {{points:Array, average:number, samples:number, months:number, source:string}}
   */
  function consumptionSeries(effectiveObj, serviceId, historyEntries, windowMonths) {
    requireDeps();
    var window = U.toNumber(windowMonths, Data.RULES.forecastWindowMonths) || 3;
    var byPeriod = {};

    (historyEntries || []).forEach(function (e) {
      if (!e || !e.period) return;
      if (serviceId && e.serviceId !== serviceId) return;
      var v = e.consumption;
      if (v === null || v === undefined) {
        if (e.current !== undefined && e.previous !== undefined) v = U.toNumber(e.current) - U.toNumber(e.previous);
      }
      byPeriod[e.period] = { period: e.period, volume: U.toNumber(v), source: 'journal' };
    });

    var archiveUsed = 0;
    var archive = effectiveObj && effectiveObj.services && effectiveObj.services.water
      ? effectiveObj.services.water.archive : null;
    if (archive && (serviceId === 'water' || serviceId === undefined)) {
      archive.forEach(function (rec) {
        if (!rec || !rec.period || byPeriod[rec.period]) return;
        byPeriod[rec.period] = { period: rec.period, volume: U.toNumber(rec.consumption), source: 'archive' };
        archiveUsed++;
      });
    }

    var points = Object.keys(byPeriod).sort().map(function (k) { return byPeriod[k]; });
    var accessible = points.filter(function (p) { return p.period; });
    var lastN = accessible.slice(-window);
    var volumes = lastN.map(function (p) { return p.volume; });
    var hasJournal = lastN.some(function (p) { return p.source === 'journal'; });
    var hasArchive = lastN.some(function (p) { return p.source === 'archive'; });
    var source = !volumes.length ? 'none'
      : (hasJournal && hasArchive ? 'mixed' : (hasJournal ? 'journal' : 'archive'));

    return {
      points: accessible,
      windowPoints: lastN,
      average: volumes.length ? U.round(U.sum(volumes) / volumes.length, Data.RULES.volumeDecimals) : 0,
      samples: volumes.length,
      months: volumes.length,
      archiveUsed: archiveUsed,
      source: source
    };
  }

  /* ======================================= ПЛОЩАДЬ И ФИКСИРОВАННЫЕ УСЛУГИ == */
  /** «Содержание МКД» / «Капитальный ремонт»: площадь × тариф */
  function areaCharge(area, rate) {
    var a = Math.max(0, U.toNumber(area));
    var r = Math.max(0, U.toNumber(rate));
    return {
      area: U.round(a, 2),
      rate: r,
      total: U.round(a * r, Data.RULES.moneyDecimals)
    };
  }

  /** Абонентская плата (интернет) */
  function fixedCharge(rate, months) {
    var m = typeof months === 'number' ? months : 1;
    return {
      rate: U.toNumber(rate),
      months: m,
      total: U.round(U.toNumber(rate) * m, Data.RULES.moneyDecimals)
    };
  }

  /* ============================================ УНИВЕРСАЛЬНЫЙ РАСЧЁТ ===== */
  /**
   * Единая точка входа для UI: считает начисление по услуге для объекта.
   * @param {object} effectiveObj эффективный объект
   * @param {string} serviceId    'maintenance' | 'caprepair' | 'electricity' | 'water' | 'internet'
   * @param {object} input        { readings, previous, volume, rateKey, months, area, rate }
   * @returns {object} результат с полями total, formula, detail
   */
  function charge(effectiveObj, serviceId, input) {
    requireDeps();
    var i = input || {};
    var svc = effectiveObj.services[serviceId];
    if (!svc) throw new Error('Неизвестная услуга: ' + serviceId);

    if (serviceId === 'maintenance' || serviceId === 'caprepair') {
      var area = i.area !== undefined ? U.toNumber(i.area) : effectiveObj.area;
      var rate = i.rate !== undefined ? U.toNumber(i.rate) : U.toNumber(svc.rate);
      var a = areaCharge(area, rate);
      return {
        serviceId: serviceId,
        total: a.total,
        formula: U.formatNumber(a.area, 2) + ' м² × ' + U.formatNumber(a.rate, 2) + ' ₽/м²',
        detail: { area: a.area, rate: a.rate }
      };
    }

    if (serviceId === 'internet') {
      var rate2 = i.rate !== undefined ? U.toNumber(i.rate) : U.toNumber(svc.rate);
      var f = fixedCharge(rate2, i.months || 1);
      return {
        serviceId: serviceId,
        total: f.total,
        formula: U.formatNumber(f.rate, 2) + ' ₽/мес.' + (f.months !== 1 ? ' × ' + f.months : ''),
        detail: { rate: f.rate, months: f.months }
      };
    }

    if (serviceId === 'electricity') {
      var bill = electricityBill(effectiveObj, i.readings, i.previous);
      return {
        serviceId: serviceId,
        total: bill.total,
        formula: 'Ступенчатая сетка «' + bill.categoryLabel + '»' +
          (bill.mode === 'day_night' ? ' (День/Ночь раздельно)' : ''),
        detail: bill
      };
    }

    if (serviceId === 'water') {
      var key = i.rateKey || svc.rateKey || Data.WATER_DEFAULT_RATE_KEY;
      var w = waterBill(i.volume, key);
      return {
        serviceId: serviceId,
        total: w.total,
        formula: U.formatNumber(w.volume, 3) + ' м³ × ' + U.formatNumber(w.rate, 2) + ' ₽/м³ (' + w.rateLabel + ')',
        detail: w
      };
    }

    return { serviceId: serviceId, total: 0, formula: '—', detail: null };
  }

  /** Стоимость 1 кВтч «в среднем» при заданном объёме (для подсказок UI) */
  function effectiveElectricityRate(effectiveObj, zoneId, consumption) {
    var scale = getElectricityScale(effectiveObj.services.electricity.category, zoneId);
    if (!scale) return 0;
    var b = breakdownBySteps(consumption, scale.steps);
    return b.averageRate;
  }

  /** Подробная справка по сетке (для таблицы тарифов в интерфейсе) */
  function describeElectricityGrid(categoryId, zoneId) {
    requireDeps();
    var cat = Data.ELECTRICITY_TARIFFS[categoryId];
    if (!cat) return null;
    var scale = cat.scales[zoneId];
    if (!scale) return null;
    var lower = 0;
    return scale.steps.map(function (st) {
      var upper = st.upTo === null ? Infinity : st.upTo;
      var row = {
        title: st.title,
        rate: st.rate,
        from: lower,
        to: st.upTo,
        rangeLabel: (lower === 0 ? '0' : U.formatNumber(lower, 0)) + ' – ' +
          (upper === Infinity ? '∞' : U.formatNumber(upper, 0)) + ' кВтч',
        volumeInStep: upper === Infinity ? null : (upper - lower)
      };
      lower = upper;
      return row;
    });
  }

  /* ================================================== ГОСПОВЕРКА ========= */
  var VERIFICATION_STATES = {
    expired: { status: 'expired', icon: '❌', label: 'ПОВЕРКА ИСТЕКЛА', css: 'bad' },
    warning: { status: 'warning', icon: '⚠️', label: 'ТРЕБУЕТСЯ ПОВЕРКА', css: 'warn' },
    ok: { status: 'ok', icon: '✅', label: 'Поверка ОК', css: 'ok' },
    unknown: { status: 'unknown', icon: '➖', label: 'Нет данных', css: 'neutral' }
  };

  /**
   * Статус госповерки прибора учёта.
   * nextCheckDate = lastCheckDate + checkPeriodYears
   *   daysLeft < 0            → ❌ ПОВЕРКА ИСТЕКЛА
   *   0 ≤ daysLeft < warnDays → ⚠️ ТРЕБУЕТСЯ ПОВЕРКА
   *   иначе                   → ✅ Поверка ОК
   * @param {object} effectiveObj объект
   * @param {string} serviceId    'electricity' | 'water'
   * @param {string} [nowISO]     текущая дата (по умолчанию — системная)
   */
  function verificationStatus(effectiveObj, serviceId, nowISO) {
    requireDeps();
    var warnDays = U.toNumber(Data.RULES.verificationWarnDays, 30);
    var svc = effectiveObj.services[serviceId] || {};
    var meter = svc.meter || {};
    var today = nowISO || U.todayISO();

    if (!meter.lastCheckDate || !(U.toNumber(meter.checkPeriodYears) > 0)) {
      return {
        hasData: false,
        serviceId: serviceId,
        lastCheckDate: meter.lastCheckDate || null,
        periodYears: meter.checkPeriodYears || null,
        nextCheckDate: null,
        daysLeft: null,
        warnDays: warnDays,
        serial: meter.serial || null,
        model: meter.model || null,
        state: VERIFICATION_STATES.unknown,
        icon: VERIFICATION_STATES.unknown.icon,
        label: VERIFICATION_STATES.unknown.label,
        css: VERIFICATION_STATES.unknown.css,
        text: 'Данные госповерки не заполнены',
        progressPercent: 0
      };
    }

    var next = U.addYearsISO(meter.lastCheckDate, meter.checkPeriodYears);
    var daysLeft = U.daysBetween(today, next);
    var totalDays = U.daysBetween(meter.lastCheckDate, next) || 1;
    var elapsed = U.daysBetween(meter.lastCheckDate, today);
    var state = daysLeft < 0 ? VERIFICATION_STATES.expired
      : (daysLeft < warnDays ? VERIFICATION_STATES.warning : VERIFICATION_STATES.ok);

    var text;
    if (state.status === 'expired') {
      text = 'просрочена ' + U.formatNumber(Math.abs(daysLeft), 0) + ' ' +
        U.plural(Math.abs(daysLeft), 'день', 'дня', 'дней') + ' назад';
    } else {
      text = 'осталось ' + U.formatNumber(daysLeft, 0) + ' ' +
        U.plural(daysLeft, 'день', 'дня', 'дней');
    }

    return {
      hasData: true,
      serviceId: serviceId,
      lastCheckDate: meter.lastCheckDate,
      periodYears: U.toNumber(meter.checkPeriodYears),
      nextCheckDate: next,
      daysLeft: daysLeft,
      warnDays: warnDays,
      serial: meter.serial || null,
      model: meter.model || null,
      state: state,
      icon: state.icon,
      label: state.label,
      css: state.css,
      text: text,
      progressPercent: U.round(U.clamp(elapsed / totalDays * 100, 0, 100), 1)
    };
  }

  /* ===================================================== ПРОГНОЗЫ ======== */
  /**
   * Средний месячный расход по услуге счётчика за последние N месяцев истории.
   * @param {Array} entries записи журнала (уже отфильтрованные по услуге+объекту)
   * @param {number} windowMonths окно усреднения (по умолчанию 3 — по ТЗ)
   * @param {object} opts { today:'YYYY-MM-DD', zone:'day'|'night' }
   */
  function averageConsumption(entries, windowMonths, opts) {
    requireDeps();
    var o = opts || {};
    var window = U.toNumber(windowMonths, Data.RULES.forecastWindowMonths) || 3;
    var today = o.today || U.todayISO();
    var list = (entries || [])
      .filter(function (e) {
        if (!e || !e.period) return false;
        if (e.serviceId !== o.serviceId) return o.serviceId ? false : true;
        if (o.objectId && e.objectId !== o.objectId) return false;
        return true;
      })
      .sort(function (a, b) { return b.period.localeCompare(a.period); });

    /* Объёмы берём из сохранённого consumption либо вычисляем из показаний */
    var volumes = [];
    for (var i = 0; i < list.length && volumes.length < window; i++) {
      var e = list[i];
      var v = e.consumption;
      if (v === null || v === undefined) {
        if (e.current !== undefined && e.previous !== undefined) v = U.toNumber(e.current) - U.toNumber(e.previous);
        else if (e.readings && e.previousReadings) {
          v = U.toNumber(e.readings.total) - U.toNumber(e.previousReadings.total);
        }
      }
      v = U.toNumber(v);
      if (v > 0) volumes.push(v);
    }
    if (!volumes.length) return { average: 0, months: 0, samples: 0, volumes: [] };
    var sum = volumes.reduce(function (a, b) { return a + b; }, 0);
    return {
      average: U.round(sum / volumes.length, Data.RULES.volumeDecimals),
      months: volumes.length,
      samples: volumes.length,
      volumes: volumes
    };
  }

  // Оставляем хук для расширения (например, зонного усреднения День/Ночь)
  void averageConsumption;

  /**
   * Прогноз «на сколько месяцев хватит аванса» для услуги объекта.
   * @param {number} balance      остаток авансового кошелька, ₽
   * @param {number} monthlyCost  расчётный ежемесячный платёж, ₽
   * @param {string} fromPeriod   период отсчёта 'YYYY-MM'
   * @returns {object} { hasForecast, months, monthsLabel, untilPeriod, untilLabel, text }
   */
  function advanceForecast(balance, monthlyCost, fromPeriod) {
    requireDeps();
    var b = U.toNumber(balance);
    var m = U.toNumber(monthlyCost);
    var period = fromPeriod || U.currentPeriod();

    if (b <= 0) {
      return {
        hasForecast: false,
        reason: 'empty',
        months: 0,
        monthsLabel: '0',
        untilPeriod: null,
        untilLabel: null,
        text: 'Аванс не внесён — кошелёк пуст.'
      };
    }
    if (m <= 0) {
      return {
        hasForecast: false,
        reason: 'no_charge',
        months: Infinity,
        monthsLabel: '∞',
        untilPeriod: null,
        untilLabel: null,
        text: 'Аванс ' + U.formatMoney(b) + ' не расходуется: ежемесячных начислений по услуге нет.'
      };
    }

    var months = b / m;
    var wholeMonths = Math.floor(months);
    var until = U.addMonths(period, wholeMonths);
    /* Формат с точкой, как в ТЗ: «хватит на 8.3 мес.» */
    var monthsLabel = months >= 100 ? '100+' : months.toFixed(1);
    var p = U.parsePeriod(until);
    /* «до июня 2027 года» (родительный) — для фразы; «июнь 2027 года» — для подписей */
    var untilLabel = p ? (U.MSK_MONTHS_GEN[p.month - 1] + ' ' + p.year + ' года') : null;
    var untilLabelNominative = p
      ? (U.MSK_MONTHS[p.month - 1].charAt(0).toUpperCase() + U.MSK_MONTHS[p.month - 1].slice(1) + ' ' + p.year)
      : null;

    return {
      hasForecast: true,
      months: U.round(months, 2),
      monthsLabel: monthsLabel,
      untilPeriod: until,
      untilLabel: untilLabel,
      untilLabelNominative: untilLabelNominative,
      monthlyCost: U.round(m, 2),
      balance: U.round(b, 2),
      text: 'Аванса ' + U.formatMoney(b) + ' хватит на ' + monthsLabel + ' мес. (ориентировочно до ' + untilLabel + ')'
    };
  }

  /**
   * Расчётный ежемесячный платёж по услуге (для прогноза аванса).
   *  • maintenance / caprepair → площадь × тариф (детерминированно по ТЗ);
   *  • internet                → абонентская плата;
   *  • electricity / water     → средний расход за 3 месяца × тарифная сетка.
   * @returns {{amount:number, basis:string, detail:object}}
   */
  function expectedMonthlyCharge(effectiveObj, serviceId, historyEntries) {
    requireDeps();
    var svc = effectiveObj.services[serviceId];
    if (!svc) return { amount: 0, basis: 'none', detail: {} };

    if (serviceId === 'maintenance' || serviceId === 'caprepair') {
      var c = areaCharge(effectiveObj.area, svc.rate);
      return {
        amount: c.total,
        basis: 'area',
        detail: { area: c.area, rate: c.rate, formula: U.formatNumber(c.area, 2) + ' м² × ' + U.formatNumber(c.rate, 2) + ' ₽/м²' }
      };
    }

    if (serviceId === 'internet') {
      return {
        amount: U.round(svc.rate, 2),
        basis: 'fixed',
        detail: { rate: svc.rate, formula: U.formatMoney(svc.rate) + '/мес.' }
      };
    }

    /* Учитываем и журнал, и исторический архив водомера (если он есть) */
    var avg = consumptionSeries(effectiveObj, serviceId, historyEntries, Data.RULES.forecastWindowMonths);
    if (!avg.samples) {
      return { amount: 0, basis: 'no_history', detail: { samples: 0 } };
    }

    if (serviceId === 'electricity') {
      var zoneIds = scalesForObject(effectiveObj);
      var total = 0;
      var pieces = [];
      var perZone = avg.average / zoneIds.length; // если истории нет по зонам — делим поровну
      zoneIds.forEach(function (z) {
        var scale = getElectricityScale(effectiveObj.services.electricity.category, z);
        var b = breakdownBySteps(perZone, scale.steps);
        total += b.total;
        pieces.push({ zone: z, volume: perZone, amount: b.total, averageRate: b.averageRate });
      });
      return {
        amount: U.round(total, 2),
        basis: 'meter_average',
        detail: {
          averageVolume: avg.average,
          samples: avg.samples,
          months: avg.months,
          source: avg.source,
          zones: pieces,
          formula: 'средний расход ' + U.formatNumber(avg.average, 1) + ' кВтч/мес за ' + avg.months + ' мес.'
        }
      };
    }

    if (serviceId === 'water') {
      var resolved = resolveWaterRateKey(effectiveObj, U.currentPeriod());
      var w = waterBill(avg.average, resolved.rateKey);
      return {
        amount: w.total,
        basis: 'meter_average',
        detail: {
          averageVolume: avg.average,
          samples: avg.samples,
          months: avg.months,
          source: avg.source,
          rate: w.rate,
          rateLabel: w.rateLabel,
          rateKey: resolved.rateKey,
          fromPeriod: resolved.fromPeriod,
          windowPoints: avg.windowPoints,
          formula: 'средний расход ' + U.formatNumber(avg.average, 2) + ' м³/мес' +
            (avg.source === 'archive' ? ' (архив водомера)' : '') + ' × ' + U.formatNumber(w.rate, 2) + ' ₽/м³'
        }
      };
    }

    return { amount: 0, basis: 'none', detail: {} };
  }

  var TariffEngine = {
    VERIFICATION_STATES: VERIFICATION_STATES,
    resolveWaterRateKey: resolveWaterRateKey,
    archiveStats: archiveStats,
    consumptionSeries: consumptionSeries,
    breakdownBySteps: breakdownBySteps,
    getElectricityScale: getElectricityScale,
    scalesForObject: scalesForObject,
    electricityBill: electricityBill,
    waterBill: waterBill,
    areaCharge: areaCharge,
    fixedCharge: fixedCharge,
    charge: charge,
    effectiveElectricityRate: effectiveElectricityRate,
    describeElectricityGrid: describeElectricityGrid,
    verificationStatus: verificationStatus,
    averageConsumption: averageConsumption,
    advanceForecast: advanceForecast,
    expectedMonthlyCharge: expectedMonthlyCharge
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.TariffEngine = TariffEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = TariffEngine;
})(typeof window !== 'undefined' ? window : globalThis);
