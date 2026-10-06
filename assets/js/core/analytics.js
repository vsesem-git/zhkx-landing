/* ============================================================================
 *  CORE / ANALYTICS — агрегаты, KPI, прогнозы и оповещения
 *  ---------------------------------------------------------------------------
 *  Слой «над» состоянием: считает итоги по периодам, объектам и услугам,
 *  строит данные для диаграмм и формирует список проблем (просроченная
 *  госповерка, долг, исчерпанный аванс и т.п.).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Data = global.ZHKX && global.ZHKX.Data;
  var U = global.ZHKX && global.ZHKX.Utils;
  var Engine = global.ZHKX && global.ZHKX.TariffEngine;
  var State = global.ZHKX && global.ZHKX.State;

  function serviceMeta(serviceId) {
    return Data.SERVICES.filter(function (s) { return s.id === serviceId; })[0] ||
      { id: serviceId, label: serviceId, short: serviceId, icon: '•', color: '#94a3b8' };
  }

  function objMeta(objId) {
    return Data.OBJECTS.filter(function (o) { return o.id === objId; })[0] || null;
  }

  /* ------------------------------------------------------------- ИТОГИ --- */
  /** Итоги одного периода: всего и в разрезе услуг/объектов */
  function summaryForPeriod(period, filter) {
    var f = filter || {};
    var list = State.entries({
      period: period,
      objectId: f.objectId || null,
      serviceId: f.serviceId || null
    });
    var byService = {};
    var byObject = {};
    Data.SERVICES.forEach(function (s) { byService[s.id] = 0; });
    Data.OBJECTS.forEach(function (o) { byObject[o.id] = 0; });
    var total = 0;
    list.forEach(function (e) {
      var amount = U.toNumber(e.amount);
      total += amount;
      byService[e.serviceId] = U.round((byService[e.serviceId] || 0) + amount, 2);
      byObject[e.objectId] = U.round((byObject[e.objectId] || 0) + amount, 2);
    });
    return { period: period, total: U.round(total, 2), byService: byService, byObject: byObject, entries: list };
  }

  /** Ряд по месяцам (по возрастанию периода) для диаграмм и таблиц */
  function periodSeries(opts) {
    var o = opts || {};
    var months = U.toNumber(o.months, 12);
    var endPeriod = o.endPeriod || U.currentPeriod();
    var out = [];
    for (var i = months - 1; i >= 0; i--) {
      var period = U.addMonths(endPeriod, -i);
      var s = summaryForPeriod(period, { objectId: o.objectId || null });
      out.push({
        period: period,
        label: U.periodLabelShort(period),
        labelFull: U.periodLabel(period),
        total: s.total,
        byService: s.byService,
        hasData: s.entries.length > 0
      });
    }
    return out;
  }

  /** Текущий (незакрытый) календарный период компьютера закрыт начислениями? */
  function isPeriodFilled(objectId, period) {
    var list = State.entries({ objectId: objectId, period: period });
    return list.length > 0;
  }

  /** Итоги по объектам за период + заполненность */
  function objectTotals(period) {
    return Data.OBJECTS.map(function (base) {
      var eff = State.effectiveObject(base.id);
      var s = summaryForPeriod(period, { objectId: base.id });
      var walletItems = walletFor(base.id);
      return {
        objectId: base.id,
        index: base.index,
        label: base.label,
        address: eff.address.full,
        owner: eff.owner,
        account: eff.account,
        els: eff.els,
        area: eff.area,
        total: s.total,
        byService: s.byService,
        filled: s.entries.length > 0,
        entriesCount: s.entries.length,
        advanceTotal: U.round(U.sum(walletItems, function (w) { return w.advance; }), 2),
        debtTotal: U.round(U.sum(walletItems, function (w) { return w.debt; }), 2)
      };
    });
  }

  /* ------------------------------------------------------------ КОШЕЛЁК --- */
  /** Кошелёк авансов объекта, обогащённый прогнозом по каждой услуге */
  function walletFor(objId) {
    var eff = State.effectiveObject(objId);
    var items = State.wallet(objId);
    var period = State.activePeriod();
    return items.map(function (item) {
      var history = State.entries({ objectId: objId, serviceId: item.serviceId });
      var expected = Engine.expectedMonthlyCharge(eff, item.serviceId, history);
      var forecast = Engine.advanceForecast(item.balance, expected.amount, period);
      var lastCharge = history[0] || null;
      return {
        objectId: objId,
        serviceId: item.serviceId,
        label: item.label,
        short: serviceMeta(item.serviceId).short,
        icon: item.icon,
        color: item.color,
        balance: item.balance,
        advance: U.round(item.advance, 2),
        debt: U.round(item.debt, 2),
        coverage: item.coverage,
        monthly: U.round(expected.amount, 2),
        monthlyBasis: expected.basis,
        monthlyDetail: expected.detail,
        forecast: forecast,
        lastCharge: lastCharge,
        movementsCount: State.movementsOf({ objectId: objId, serviceId: item.serviceId }).length
      };
    });
  }

  function walletsSummary() {
    var objects = Data.OBJECTS.map(function (base) {
      var items = walletFor(base.id);
      return {
        objectId: base.id,
        index: base.index,
        label: base.label,
        address: base.address.full,
        owner: base.owner,
        items: items,
        advanceTotal: U.round(U.sum(items, function (i) { return i.advance; }), 2),
        debtTotal: U.round(U.sum(items, function (i) { return i.debt; }), 2)
      };
    });
    return {
      objects: objects,
      advanceTotal: U.round(U.sum(objects, function (o) { return o.advanceTotal; }), 2),
      debtTotal: U.round(U.sum(objects, function (o) { return o.debtTotal; }), 2)
    };
  }

  /**
   * Прогноз по счётчикам (свет/вода) на основе среднего расхода за 3 месяца.
   * @returns {{average:number, unit:string, samples:number, monthlyCost:number, text:string}}
   */
  function meterForecast(objId, serviceId) {
    var eff = State.effectiveObject(objId);
    var history = State.entries({ objectId: objId, serviceId: serviceId });
    var window = Data.RULES.forecastWindowMonths;
    /* Для воды в расчёт подмешивается исторический архив водомера из data-слоя */
    var series = Engine.consumptionSeries(eff, serviceId, history, window);
    var unit = serviceId === 'electricity' ? 'кВтч' : 'м³';
    var decimals = serviceId === 'water' ? 2 : 1;

    if (!series.samples) {
      return {
        hasData: false,
        average: 0, unit: unit, samples: 0, monthlyCost: 0, source: 'none',
        text: 'Недостаточно истории: нужно минимум 1 закрытый месяц (рекомендуется ' + window + ').'
      };
    }

    var perMonth = Engine.expectedMonthlyCharge(eff, serviceId, history);
    var volumesText = series.windowPoints.map(function (p) {
      return U.formatNumber(p.volume, serviceId === 'water' ? 2 : 0) + (p.source === 'archive' ? '*' : '');
    }).join(' · ');
    var sourceLabel = series.source === 'archive' ? ' (архив водомера)' : (series.source === 'mixed' ? ' (журнал + архив)' : '');
    var periodsText = series.windowPoints.map(function (p) { return U.periodLabelShort(p.period); }).join(' · ');

    return {
      hasData: true,
      average: series.average,
      unit: unit,
      samples: series.samples,
      months: series.months,
      volumes: series.windowPoints.map(function (p) { return p.volume; }),
      windowPoints: series.windowPoints,
      source: series.source,
      monthlyCost: U.round(perMonth.amount, 2),
      basis: perMonth.basis,
      detail: perMonth.detail,
      text: 'Средний расход за ' + series.months + ' ' + U.plural(series.months, 'месяц', 'месяца', 'месяцев') + sourceLabel +
        ': ' + U.formatNumber(series.average, decimals) + ' ' + unit + '/мес. (' + volumesText + ')' +
        ' → ориентировочно ' + U.formatMoney(perMonth.amount) + '/мес.' +
        (periodsText ? ' Периоды: ' + periodsText + '.' : '')
    };
  }

  /* ------------------------------------------------ ВОДА: ТАРИФЫ, АРХИВ --- */
  /** Тариф воды, действующий для объекта в указанном периоде (селектор периодов) */
  function waterTariffFor(objId, period) {
    var eff = State.effectiveObject(objId);
    return Engine.resolveWaterRateKey(eff, period || State.activePeriod(), State.waterSchedule(objId));
  }

  /** Сегменты графика тарифов воды: «с какого по какой период действует ставка» */
  function waterScheduleSegments(objId) {
    var rows = State.waterSchedule(objId);
    var current = State.activePeriod();
    return rows.map(function (row, i) {
      var next = rows[i + 1] || null;
      var tariff = Data.WATER_TARIFFS[row.rateKey];
      return {
        fromPeriod: row.fromPeriod,
        toPeriod: next ? U.addMonths(next.fromPeriod, -1) : null,
        rateKey: row.rateKey,
        rate: tariff.rate,
        label: tariff.label,
        note: row.note || '',
        isActive: row.fromPeriod <= current && (!next || next.fromPeriod > current),
        isCustomized: State.isScheduleCustomized(objId)
      };
    });
  }

  /** Сводка по архиву водомера: показания, расход, оценка стоимости */
  function waterArchiveSummary(objId) {
    var info = State.waterArchiveInfo(objId);
    var stats = info.stats;
    var actual = waterTariffFor(objId, U.currentPeriod());
    return {
      objectId: objId,
      account: info.account,
      accountNote: info.accountNote,
      hasArchive: info.hasArchive,
      stats: stats,
      archive: info.archive,
      importedPeriods: info.importedPeriods,
      pendingPeriods: info.pendingPeriods,
      months: stats.count,
      average: stats.average,
      averageAll: stats.averageAll,
      windowVolumes: stats.windowVolumes,
      lastReading: stats.lastReading,
      lastPeriod: stats.lastPeriod,
      lastConsumption: stats.lastConsumption,
      totalConsumption: stats.totalConsumption,
      firstPeriod: stats.firstPeriod,
      tariff: actual,
      costEstimate: Engine.waterBill(stats.average, actual.rateKey).total,
      totalCost: Engine.waterBill(stats.totalConsumption, actual.rateKey).total,
      forecast: Engine.expectedMonthlyCharge(State.effectiveObject(objId), 'water', State.entries({ objectId: objId, serviceId: 'water' }))
    };
  }

  /* --------------------------------------------------------- ГОСПОВЕРКА --- */
  /** Индекс госповерки по всем объектам/счётчикам, отсортированный по срочности */
  function verificationIndex(nowISO) {
    var today = nowISO || U.todayISO();
    var rows = [];
    State.effectiveObjects().forEach(function (eff) {
      ['electricity', 'water'].forEach(function (serviceId) {
        var svc = eff.services[serviceId];
        if (!svc || svc.enabled === false) return;
        var st = Engine.verificationStatus(eff, serviceId, today);
        rows.push(Object.assign({
          objectId: eff.id,
          objectIndex: eff.index,
          objectLabel: eff.label,
          address: eff.address.full,
          serviceId: serviceId,
          serviceLabel: serviceId === 'electricity' ? 'Электроэнергия' : 'Водоснабжение',
          icon: serviceId === 'electricity' ? '⚡' : '💧'
        }, st));
      });
    });
    var weight = { expired: 0, warning: 1, ok: 2, unknown: 3 };
    return rows.sort(function (a, b) {
      var w = weight[a.css] - weight[b.css];
      if (w !== 0) return w;
      return (a.daysLeft === null ? 1e9 : a.daysLeft) - (b.daysLeft === null ? 1e9 : b.daysLeft);
    });
  }

  /* ---------------------------------------------------------- СИГНАЛЫ ----- */
  /** Список проблем и подсказок для панели «Мониторинг» */
  function alerts(nowISO) {
    var today = nowISO || U.todayISO();
    var list = [];
    var period = State.activePeriod();

    verificationIndex(today).forEach(function (row) {
      if (row.css === 'expired') {
        list.push({
          level: 'danger',
          icon: '❌',
          title: 'Госповерка истекла: ' + row.objectLabel + ' · ' + row.serviceLabel,
          text: 'Поверка была действительна до ' + U.formatDateISO(row.nextCheckDate) +
            ' (просрочка ' + U.formatNumber(Math.abs(row.daysLeft), 0) + ' дн.). Счётчик № ' + (row.serial || '—') + ' требует поверки/замены.',
          objectId: row.objectId, serviceId: row.serviceId, action: 'verification'
        });
      } else if (row.css === 'warning') {
        list.push({
          level: 'warn',
          icon: '⚠️',
          title: 'Скоро госповерка: ' + row.objectLabel + ' · ' + row.serviceLabel,
          text: 'Срок поверки ' + U.formatDateISO(row.nextCheckDate) + ' — осталось ' + row.daysLeft + ' дн. Счётчик № ' + (row.serial || '—') + '.',
          objectId: row.objectId, serviceId: row.serviceId, action: 'verification'
        });
      } else if (row.css === 'unknown') {
        list.push({
          level: 'info',
          icon: '➖',
          title: 'Не заполнены данные поверки: ' + row.objectLabel + ' · ' + row.serviceLabel,
          text: 'Укажите номер прибора учёта, дату последней поверки и межповерочный интервал, чтобы система следила за сроком.',
          objectId: row.objectId, serviceId: row.serviceId, action: 'verification'
        });
      }
    });

    /* Незакрытые периоды: если не заполнено ничего — одно сводное оповещение,
       иначе перечисляем только «пропущенные» объекты. */
    var missing = Data.OBJECTS.filter(function (o) { return !isPeriodFilled(o.id, period); });
    if (missing.length === Data.OBJECTS.length) {
      list.push({
        level: 'info',
        icon: '🗓️',
        title: 'Начисления за ' + U.periodLabelLower(period) + ' ещё не внесены',
        text: 'Ни по одному объекту нет записей за этот период. Откройте калькулятор и внесите показания — расчёт произойдёт автоматически.',
        objectId: null, action: 'add-entry'
      });
    } else if (missing.length) {
      list.push({
        level: 'info',
        icon: '🗓️',
        title: 'Нет начислений за ' + U.periodLabelLower(period) + ': ' + missing.length + ' ' +
          U.plural(missing.length, 'объект', 'объекта', 'объектов'),
        text: missing.map(function (o) { return '№' + o.index + ' ' + o.label; }).join(', ') + '.',
        objectId: missing[0].id, action: 'add-entry'
      });
    }

    Data.OBJECTS.forEach(function (base) {
      var items = walletFor(base.id);
      items.forEach(function (it) {
        if (it.debt > 0.5) {
          list.push({
            level: 'warn',
            icon: '📉',
            title: 'Долг по услуге «' + it.label + '»: ' + base.label,
            text: 'Задолженность ' + U.formatMoney(it.debt) + '. Внесите оплату или добавьте аванс в кошелёк.',
            objectId: base.id, serviceId: it.serviceId, action: 'wallet'
          });
        } else if (it.advance > 0 && it.forecast && it.forecast.hasForecast && it.forecast.months < 1) {
          list.push({
            level: 'info',
            icon: '⏳',
            title: 'Аванс почти исчерпан: ' + base.label + ' · ' + it.label,
            text: it.forecast.text,
            objectId: base.id, serviceId: it.serviceId, action: 'wallet'
          });
        }
      });
    });

    var order = { danger: 0, warn: 1, info: 2 };
    return list.sort(function (a, b) { return order[a.level] - order[b.level]; });
  }

  /* ---------------------------------------------------------- KPI-БЛОК --- */
  function kpi() {
    var period = State.activePeriod();
    var now = U.parsePeriod(period);
    var year = now ? now.year : new Date().getFullYear();
    var current = summaryForPeriod(period);
    var yearTotal = 0;
    var periodsWithData = 0;
    for (var m = 1; m <= 12; m++) {
      var s = summaryForPeriod(U.makePeriod(year, m));
      yearTotal += s.total;
      if (s.entries.length) periodsWithData++;
    }
    var wallets = walletsSummary();
    var today = U.todayISO();
    var verifications = verificationIndex(today);
    var expired = verifications.filter(function (v) { return v.css === 'expired'; }).length;
    var warning = verifications.filter(function (v) { return v.css === 'warning'; }).length;

    var prevPeriod = U.addMonths(period, -1);
    var prev = summaryForPeriod(prevPeriod);
    var delta = prev.total > 0 ? (current.total - prev.total) / prev.total * 100 : null;

    return {
      period: period,
      periodLabel: U.periodLabel(period),
      year: year,
      currentTotal: current.total,
      currentByService: current.byService,
      prevPeriod: prevPeriod,
      prevTotal: prev.total,
      delta: delta === null ? null : U.round(delta, 1),
      yearTotal: U.round(yearTotal, 2),
      monthsWithData: periodsWithData,
      advanceTotal: wallets.advanceTotal,
      debtTotal: wallets.debtTotal,
      expiredCount: expired,
      warningCount: warning,
      verificationTotal: verifications.length,
      journalCount: State.entries({}).length
    };
  }

  /* ------------------------------------------------------------- ЧАРТЫ --- */
  /** Данные для круговой диаграммы структуры расходов */
  function pieByObject(period) {
    var totals = objectTotals(period);
    return {
      labels: totals.map(function (t) { return t.label; }),
      values: totals.map(function (t) { return U.round(t.total, 2); }),
      colors: ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#10b981', '#ef4444'],
      meta: totals
    };
  }

  function pieByService(period, objectId) {
    var s = summaryForPeriod(period, objectId ? { objectId: objectId } : {});
    var items = Data.SERVICES
      .map(function (svc) { return { id: svc.id, label: svc.label, color: svc.color, value: U.round(s.byService[svc.id] || 0, 2) }; })
      .filter(function (i) { return i.value > 0; });
    return {
      labels: items.map(function (i) { return i.label; }),
      values: items.map(function (i) { return i.value; }),
      colors: items.map(function (i) { return i.color; }),
      meta: items
    };
  }

  /** Ряд «по месяцам» для столбчатой/линейной диаграммы */
  function monthlyChart(months, objectId) {
    var series = periodSeries({ months: months || 12, objectId: objectId || null });
    return {
      labels: series.map(function (s) { return s.label; }),
      values: series.map(function (s) { return U.round(s.total, 2); }),
      hasData: series.map(function (s) { return s.hasData; }),
      series: series
    };
  }

  /* -------------------------------------------------------------- УТИЛЫ -- */
  /** Журнал → CSV (для Excel; разделитель ';', BOM для Windows) */
  function journalToCSV(list) {
    var head = ['Период', 'Дата', 'Объект', 'Лицевой счёт', 'Адрес', 'Услуга',
      'Начислено, руб', 'Тариф', 'Ед.', 'Расход', 'Ед. расхода', 'Способ', 'Комментарий'];
    function esc(v) {
      var t = String(v === null || v === undefined ? '' : v).replace(/"/g, '""');
      return '"' + t + '"';
    }
    function row(e) {
      var eff = State.effectiveObject(e.objectId);
      var svc = serviceMeta(e.serviceId);
      var unit = svc.kind === 'area' ? 'руб./м²' : (e.serviceId === 'electricity' ? 'руб./кВтч' : (e.serviceId === 'water' ? 'руб./м³' : 'руб./мес.'));
      var amountUnit = svc.kind === 'area' ? 'м²' : (e.serviceId === 'electricity' ? 'кВтч' : (e.serviceId === 'water' ? 'м³' : 'мес.'));
      var consumption = e.consumption;
      if (consumption === null || consumption === undefined) {
        consumption = svc.kind === 'area' ? eff.area : '';
      }
      return [
        e.period, e.date, eff.label, eff.account, eff.address.full, svc.label,
        U.formatNumber(e.amount, 2).replace(/\s/g, ''), e.rate === null ? '' : U.formatNumber(e.rate, 2).replace(/\s/g, ''),
        unit, U.formatNumber(consumption, svc.kind === 'area' ? 2 : 3).replace(/\s/g, ''), amountUnit,
        e.amountSource === 'manual' ? 'вручную' : 'авторасчёт', e.note
      ].map(esc).join(';');
    }
    var lines = [head.map(esc).join(';')].concat((list || []).map(row));
    return '\uFEFF' + lines.join('\r\n');
  }

  var Analytics = {
    serviceMeta: serviceMeta,
    objMeta: objMeta,
    waterTariffFor: waterTariffFor,
    waterScheduleSegments: waterScheduleSegments,
    waterArchiveSummary: waterArchiveSummary,
    summaryForPeriod: summaryForPeriod,
    periodSeries: periodSeries,
    isPeriodFilled: isPeriodFilled,
    objectTotals: objectTotals,
    walletFor: walletFor,
    walletsSummary: walletsSummary,
    meterForecast: meterForecast,
    verificationIndex: verificationIndex,
    alerts: alerts,
    kpi: kpi,
    pieByObject: pieByObject,
    pieByService: pieByService,
    monthlyChart: monthlyChart,
    journalToCSV: journalToCSV
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.Analytics = Analytics;
  if (typeof module !== 'undefined' && module.exports) module.exports = Analytics;
})(typeof window !== 'undefined' ? window : globalThis);
