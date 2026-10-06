/* ============================================================================
 *  UI / FORMS — калькулятор «на лету», модальные окна и контроллер ввода
 *  ---------------------------------------------------------------------------
 *  Ключевые возможности:
 *    • мгновенный пересчёт «Начислено» при выборе услуги/объекта/показаний;
 *    • все поля открыты для ручной правки (авторежим отключается сам);
 *    • расчёт электроэнергии по ступеням с наглядной детализацией;
 *    • распределение начисления по зонам дома (10-й этаж, гараж, жильцы…);
 *    • предпросмотр влияния начисления на авансовый кошелёк и прогноз.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Data = global.ZHKX.Data;
  var U = global.ZHKX.Utils;
  var Engine = global.ZHKX.TariffEngine;
  var State = global.ZHKX.State;
  var Analytics = global.ZHKX.Analytics;
  var Views = global.ZHKX.Views;
  var S = Data.SERVICES;

  function svc(id) { return S.filter(function (s) { return s.id === id; })[0]; }
  function $1(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ============================================================== МОДАЛКИ */
  var Modal = {
    open: function (opts) {
      var o = opts || {};
      var host = document.getElementById('modal-host');
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true" aria-label="' + U.escapeHtml(o.title || 'Диалог') + '">' +
          '<header class="modal__head"><h3>' + U.escapeHtml(o.title || '') + '</h3>' +
            '<button class="btn btn--icon" data-action="modal-close" aria-label="Закрыть">✕</button></header>' +
          '<div class="modal__body">' + (o.body || '') + '</div>' +
          (o.footer ? '<footer class="modal__foot">' + o.footer + '</footer>' : '') +
        '</div>';
      host.innerHTML = '';
      host.appendChild(backdrop);
      host.hidden = false;
      document.body.classList.add('has-modal');

      backdrop.addEventListener('click', function (evt) {
        if (evt.target === backdrop || evt.target.closest('[data-action="modal-close"]')) Modal.close();
      });
      document.addEventListener('keydown', Modal._esc = function (e) {
        if (e.key === 'Escape') Modal.close();
      });
      if (typeof o.onMount === 'function') o.onMount(backdrop);
      var focusable = backdrop.querySelector('input, select, textarea, button');
      if (focusable) setTimeout(function () { focusable.focus(); }, 30);
      return backdrop;
    },
    close: function () {
      var host = document.getElementById('modal-host');
      if (!host) return;
      host.innerHTML = '';
      host.hidden = true;
      document.body.classList.remove('has-modal');
      if (Modal._esc) document.removeEventListener('keydown', Modal._esc);
    },
    isOpen: function () { return !document.getElementById('modal-host').hidden; }
  };

  /* ======================================================= РАСПРЕДЕЛЕНИЕ == */
  /**
   * Распределение итогового начисления по зонам/секциям дома.
   * Базы: 'area' — площадь секции, 'points' — число жильцов, 'manual' — фиксированная сумма.
   * Фиксированные суммы вычитаются из итога, остаток делится пропорционально весам
   * (вес = значение × доля собственника, доля по умолчанию 100 %).
   */
  function computeSections(sections, total) {
    var rows = (sections || []).map(function (s) {
      var share = s.share === '' || s.share === null || s.share === undefined ? 100 : U.toNumber(s.share, 100);
      var value = U.toNumber(s.value);
      return {
        name: s.name || 'Секция',
        basis: s.basis || 'area',
        value: value,
        share: U.clamp(share, 0, 100),
        manualAmount: U.toNumber(s.manualAmount),
        weight: s.basis === 'manual' ? 0 : value * (U.clamp(share, 0, 100) / 100),
        amount: 0
      };
    });

    var manualTotal = U.sum(rows.filter(function (r) { return r.basis === 'manual'; }), function (r) { return r.manualAmount; });
    var weightTotal = U.sum(rows.filter(function (r) { return r.basis !== 'manual'; }), function (r) { return r.weight; });
    var remainder = U.round(U.toNumber(total) - manualTotal, 2);
    var distributed = 0;

    rows.forEach(function (r) {
      if (r.basis === 'manual') { r.amount = U.round(r.manualAmount, 2); }
      else if (weightTotal > 0) { r.amount = U.round(remainder * (r.weight / weightTotal), 2); }
      else { r.amount = 0; }
      distributed += r.amount;
    });

    var warnings = [];
    if (remainder < -0.01) warnings.push('Фиксированные суммы превышают итоговое начисление на ' + U.formatMoney(Math.abs(remainder)) + '.');
    if (rows.length && weightTotal <= 0 && rows.some(function (r) { return r.basis !== 'manual'; })) {
      warnings.push('Не заполнены площади/жильцы — распределить остаток не удалось.');
    }

    return {
      rows: rows,
      manualTotal: U.round(manualTotal, 2),
      weightTotal: U.round(weightTotal, 2),
      remainder: remainder,
      distributed: U.round(distributed, 2),
      warnings: warnings
    };
  }

  /* ============================================ КАЛЬКУЛЯТОР (КОНТРОЛЛЕР) == */
  var Entry = {
    root: null,
    autoAmount: true,
    draft: null,

    defaultDraft: function () {
      return {
        objectId: State.activeObjectId(),
        serviceId: 'maintenance',
        period: State.activePeriod(),
        date: '',
        note: '',
        amountOverride: null,
        months: 1,
        waterRateKey: null,
        readings: {},
        previous: {},
        sections: []
      };
    },

    object: function () { return State.effectiveObject(Entry.draft.objectId); },

    mount: function (root) {
      Entry.root = root;
      if (!Entry.draft) Entry.draft = Entry.defaultDraft();
      if (!root) return;
      /* Контейнер раздела живёт постоянно, поэтому обработчики навешиваем
         строго один раз — иначе повторный рендер раздела дублирует их. */
      if (Entry._boundRoot !== root) {
        if (Entry._boundRoot) {
          Entry._boundRoot.removeEventListener('input', Entry.onInput);
          Entry._boundRoot.removeEventListener('change', Entry.onInput);
          Entry._boundRoot.removeEventListener('submit', Entry.onSubmit);
          Entry._boundRoot.removeEventListener('click', Entry.onClick);
        }
        root.addEventListener('input', Entry.onInput);
        root.addEventListener('change', Entry.onInput);
        root.addEventListener('submit', Entry.onSubmit);
        root.addEventListener('click', Entry.onClick);
        Entry._boundRoot = root;
      }
      Entry.syncReadingsFromHistory();
      Entry.renderDynamic();
      Entry.updatePreview();
    },

    unmount: function () {
      Entry.root = null;
    },

    /* --- изменения в форме ------------------------------------------------- */
    onInput: function (evt) {
      var t = evt.target;
      if (!t || !t.name) return;
      var name = t.name;

      if (name === 'objectId') {
        Entry.draft.objectId = t.value;
        Entry.draft.sections = [];
        Entry.draft.amountOverride = null;
        Entry.draft.waterRateKey = null;
        Entry.autoAmount = true;
        Entry.syncReadingsFromHistory();
        Entry.renderDynamic();
        State.setSetting('activeObjectId', t.value);
      } else if (name === 'serviceId') {
        Entry.draft.serviceId = t.value;
        Entry.draft.amountOverride = null;
        Entry.draft.waterRateKey = null;
        Entry.autoAmount = true;
        Entry.syncReadingsFromHistory();
        Entry.renderDynamic();
      } else if (name === 'period') {
        Entry.draft.period = t.value || U.currentPeriod();
        /* Другой месяц — значит другая ставка по графику периодов */
        Entry.draft.waterRateKey = null;
        Entry.syncReadingsFromHistory();
        Entry.renderDynamic();
      } else if (name === 'waterRateKey') {
        /* Тариф, выбранный вручную, действует для этой записи; постоянный тариф
           объекта задаётся в ⚙️ «Параметры услуги», а по умолчанию берётся из
           графика периодов (раздел «Тарифы» → «Селектор периодов»). */
        Entry.draft.waterRateKey = t.value;
      } else if (name === 'amount') {
        /* Сравниваем ввод с ЧИСТЫМ авторасчётом (без учёта прошлой правки),
           иначе повторный ввод той же суммы вернул бы авторежим. */
        var computed = Entry.compute().autoAmount;
        var typed = U.toNumber(t.value);
        Entry.autoAmount = t.value === '' || Math.abs(typed - computed) < 0.005;
        Entry.draft.amountOverride = Entry.autoAmount ? null : typed;
        Entry.updatePreview();
        return Entry.renderDynamic({ keepFocus: true });
      } else if (name === 'autoAmount') {
        Entry.autoAmount = t.checked;
        Entry.draft.amountOverride = null;
        Entry.renderDynamic();
      } else if (/^(cur|prev)(Day|Night|Total)$/.test(name) || name === 'currentReading') {
        Entry.readReadings();
        Entry.renderDynamic({ keepFocus: true });
      } else if (/^(sec|area|rate|months|date|note)/.test(name)) {
        Entry.readMisc();
        Entry.renderDynamic({ keepFocus: true });
      } else {
        Entry.readMisc();
        Entry.readReadings();
      }
      Entry.updatePreview();
    },

    onClick: function (evt) {
      var btn = evt.target.closest('[data-entry-action]');
      if (!btn) return;
      evt.preventDefault();
      var action = btn.getAttribute('data-entry-action');
      if (action === 'add-section') {
        Entry.readMisc();
        Entry.draft.sections.push({ name: 'Секция ' + (Entry.draft.sections.length + 1), basis: 'area', value: 0, share: 100, manualAmount: 0 });
        Entry.renderDynamic();
        Entry.updatePreview();
      } else if (action === 'remove-section') {
        Entry.readMisc();
        var idx = U.toNumber(btn.getAttribute('data-index'));
        Entry.draft.sections.splice(idx, 1);
        Entry.renderDynamic();
        Entry.updatePreview();
      } else if (action === 'fill-previous') {
        Entry.syncReadingsFromHistory();
        Entry.renderDynamic();
        Entry.updatePreview();
      } else if (action === 'reset') {
        Entry.draft = Entry.defaultDraft();
        Entry.autoAmount = true;
        Entry.root && Entry.root.querySelector('form') && Entry.root.querySelector('form').reset();
        Entry.syncReadingsFromHistory();
        Entry.renderDynamic();
        Entry.updatePreview();
      } else if (action === 'save') {
        Entry.save();
      }
    },

    onSubmit: function (evt) { evt.preventDefault(); },

    /* --- чтение DOM ------------------------------------------------------- */
    readMisc: function () {
      var root = Entry.root;
      if (!root) return;
      var d = Entry.draft;
      var areaInput = $1('[name="area"]', root);
      var rateInput = $1('[name="rate"]', root);
      var monthsInput = $1('[name="months"]', root);
      var dateInput = $1('[name="date"]', root);
      var noteInput = $1('[name="note"]', root);
      if (areaInput) d.area = areaInput.value === '' ? null : U.toNumber(areaInput.value);
      if (rateInput) d.rate = rateInput.value === '' ? null : U.toNumber(rateInput.value);
      if (monthsInput) d.months = Math.max(1, U.toNumber(monthsInput.value, 1));
      if (dateInput) d.date = dateInput.value;
      if (noteInput) d.note = noteInput.value;

      d.sections = $$('[data-section-row]', root).map(function (row) {
        return {
          name: $1('[data-sec="name"]', row) ? $1('[data-sec="name"]', row).value : '',
          basis: $1('[data-sec="basis"]', row) ? $1('[data-sec="basis"]', row).value : 'area',
          value: $1('[data-sec="value"]', row) ? U.toNumber($1('[data-sec="value"]', row).value) : 0,
          share: $1('[data-sec="share"]', row) ? U.toNumber($1('[data-sec="share"]', row).value, 100) : 100,
          manualAmount: $1('[data-sec="manual"]', row) ? U.toNumber($1('[data-sec="manual"]', row).value) : 0
        };
      });
    },

    readReadings: function () {
      var root = Entry.root;
      if (!root) return;
      var d = Entry.draft;
      d.readings = {};
      d.previous = {};
      var zones = Entry.zones();
      if (zones.length > 1) {
        zones.forEach(function (z) {
          var cur = $1('[name="cur' + cap(z) + '"]', root);
          var prev = $1('[name="prev' + cap(z) + '"]', root);
          if (cur) d.readings[z] = cur.value === '' ? null : U.toNumber(cur.value);
          if (prev) d.previous[z] = prev.value === '' ? null : U.toNumber(prev.value);
        });
      } else {
        var curT = $1('[name="curTotal"]', root);
        var prevT = $1('[name="prevTotal"]', root);
        if (curT) d.readings.total = curT.value === '' ? null : U.toNumber(curT.value);
        if (prevT) d.previous.total = prevT.value === '' ? null : U.toNumber(prevT.value);
      }
    },

    zones: function () {
      var d = Entry.draft;
      if (d.serviceId !== 'electricity') return ['total'];
      return Engine.scalesForObject(Entry.object());
    },

    /** Автозаполнение предыдущих показаний из журнала/снапшота */
    syncReadingsFromHistory: function () {
      var d = Entry.draft;
      var root = Entry.root;
      if (d.serviceId !== 'electricity' && d.serviceId !== 'water') return;

      var ms = State.meterState(d.objectId, d.serviceId, d.period);
      d.previous = Object.assign({}, ms.previous || {});
      d.readings = Object.assign({}, ms.current || {});

      if (root) {
        var zones = Entry.zones();
        if (zones.length > 1) {
          zones.forEach(function (z) {
            var cur = $1('[name="cur' + cap(z) + '"]', root);
            var prev = $1('[name="prev' + cap(z) + '"]', root);
            if (cur && (cur.value === '' || cur.value === '0')) cur.value = d.readings[z] === undefined || d.readings[z] === null ? '' : d.readings[z];
            if (prev && (prev.value === '' || prev.value === '0')) prev.value = d.previous[z] === undefined || d.previous[z] === null ? '' : d.previous[z];
          });
        } else {
          var curT = $1('[name="curTotal"]', root);
          var prevT = $1('[name="prevTotal"]', root);
          if (curT && (curT.value === '' || curT.value === '0')) curT.value = d.readings.total === undefined || d.readings.total === null ? '' : d.readings.total;
          if (prevT && (prevT.value === '' || prevT.value === '0')) prevT.value = d.previous.total === undefined || d.previous.total === null ? '' : d.previous.total;
        }
      }
      if (!d.date) d.date = U.periodEndISO(d.period) || U.todayISO();
    },

    /** Полный расчёт текущего черновика (без DOM) */
    compute: function () {
      var root = Entry.root;
      if (root) { Entry.readMisc(); Entry.readReadings(); }
      var d = Entry.draft;
      var obj = Entry.object();
      var meta = svc(d.serviceId);
      var out = {
        serviceId: d.serviceId,
        meta: meta,
        amount: 0,
        autoAmount: 0,
        formula: '—',
        breakdown: null,
        consumption: null,
        rate: null,
        rateKey: null,
        readings: null,
        previous: null,
        warnings: [],
        details: []
      };

      if (meta.kind === 'area') {
        var area = (d.area === null || d.area === undefined) ? obj.area : U.toNumber(d.area);
        var rate = (d.rate === null || d.rate === undefined) ? U.toNumber(obj.services[d.serviceId].rate) : U.toNumber(d.rate);
        var ch = Engine.areaCharge(area, rate);
        out.autoAmount = ch.total;
        out.formula = U.formatNumber(ch.area, 2) + ' м² × ' + U.formatNumber(ch.rate, 2) + ' ₽/м²';
        out.details.push({ label: 'Площадь объекта', value: U.formatNumber(ch.area, 2) + ' м²' });
        out.details.push({ label: 'Тариф услуги', value: U.formatNumber(ch.rate, 2) + ' ₽/м²' });
        out.rate = ch.rate;
      } else if (meta.kind === 'fixed') {
        var months = Math.max(1, U.toNumber(d.months, 1));
        var fixedRate = (d.rate === null || d.rate === undefined) ? U.toNumber(obj.services[d.serviceId].rate) : U.toNumber(d.rate);
        var f = Engine.fixedCharge(fixedRate, months);
        out.autoAmount = f.total;
        out.formula = U.formatMoney(f.rate) + '/мес. × ' + months + ' ' + U.plural(months, 'месяц', 'месяца', 'месяцев');
        out.rate = f.rate;
      } else if (d.serviceId === 'electricity') {
        var bill = Engine.electricityBill(obj, d.readings, d.previous);
        out.autoAmount = bill.total;
        out.breakdown = bill;
        out.consumption = bill.consumption;
        out.readings = d.readings;
        out.previous = d.previous;
        out.formula = 'Ступенчатая сетка «' + bill.categoryLabel + '»' + (bill.mode === 'day_night' ? ' · зоны День/Ночь раздельно' : '');
        bill.zones.forEach(function (z) {
          if (z.consumption < 0) {
            out.warnings.push('Зона «' + z.label + '»: текущее показание меньше предыдущего — расход обнулён. Проверьте ввод.');
          }
        });
        if (U.toNumber(d.readings.total || d.readings.day || 0) < U.toNumber(d.previous.total || d.previous.day || 0)) {
          out.warnings.push('Текущие показания меньше предыдущих — расход обнулён. Проверьте ввод.');
        }
      } else if (d.serviceId === 'water') {
        var schedPick = Engine.resolveWaterRateKey(obj, d.period, State.waterSchedule(obj.id));
        var key = d.waterRateKey || schedPick.rateKey;
        var volume = Math.max(0, U.toNumber(d.readings.total) - U.toNumber(d.previous.total));
        var w = Engine.waterBill(volume, key);
        out.autoAmount = w.total;
        out.consumption = w.volume;
        out.rate = w.rate;
        out.rateKey = w.rateKey;
        out.readings = d.readings;
        out.previous = d.previous;
        out.formula = U.formatNumber(w.volume, 3) + ' м³ × ' + U.formatNumber(w.rate, 2) + ' ₽/м³ (' + w.rateLabel + ')';
        out.details.push({ label: 'Предыдущее показание', value: U.formatNumber(U.toNumber(d.previous.total), 3) + ' м³' });
        out.details.push({ label: 'Текущее показание', value: U.formatNumber(U.toNumber(d.readings.total), 3) + ' м³' });
        if (!d.waterRateKey) {
          out.details.push({
            label: 'Тариф по графику периодов',
            value: U.periodLabel(d.period) + ': ' + U.formatNumber(schedPick.rate, 2) + ' ₽/м³' +
              (schedPick.fromPeriod && schedPick.fromPeriod !== d.period ? ' (с ' + U.periodLabelShort(schedPick.fromPeriod) + ')' : '')
          });
        }
        if (volume === 0) out.warnings.push('Расход воды равен нулю — начисление 0 ₽.');
      }

      /* Итоговая сумма: авторежим либо ручная правка «Начислено» */
      out.amount = (Entry.draft.amountOverride !== null && !Entry.autoAmount)
        ? U.round(U.toNumber(Entry.draft.amountOverride), 2)
        : out.autoAmount;

      /* Распределение по секциям */
      out.sectionPlan = computeSections(Entry.draft.sections, out.amount);
      out.warnings = out.warnings.concat(out.sectionPlan.warnings);

      /* Влияние на авансовый кошелёк */
      var balance = State.balance(d.objectId, d.serviceId);
      var after = U.round(balance - out.amount, 2);
      var history = State.entries({ objectId: d.objectId, serviceId: d.serviceId });
      var expected = Engine.expectedMonthlyCharge(obj, d.serviceId, history);
      out.wallet = {
        balance: balance,
        after: after,
        willBeCovered: U.round(Math.min(out.amount, Math.max(0, balance)), 2),
        willBeDebt: U.round(Math.max(0, out.amount - Math.max(0, balance)), 2),
        monthly: U.round(expected.amount, 2),
        forecastAfter: Engine.advanceForecast(Math.max(0, after), expected.amount, d.period)
      };
      return out;
    },

    /* --- отрисовка --------------------------------------------------------- */
    renderDynamic: function (opts) {
      var o = opts || {};
      var root = Entry.root;
      if (!root) return;
      var host = $1('[data-entry-fields]', root);
      if (!host) return;
      var focused = document.activeElement;
      var focusName = focused && focused.name ? focused.name : null;
      var focusPos = focused && focused.selectionStart;
      host.innerHTML = Entry.fieldsHtml();
      var summaryHost = $1('[data-entry-breakdown]', root);
      if (summaryHost) summaryHost.innerHTML = Entry.breakdownHtml();
      if (o.keepFocus && focusName) {
        var again = $1('[name="' + focusName + '"]', root);
        if (again) { again.focus(); if (focusPos !== null && again.setSelectionRange) { try { again.setSelectionRange(focusPos, focusPos); } catch (e) { /* number input */ } } }
      }
    },

    fieldHtml: function (label, inner, hint, cls) {
      return '<div class="field ' + (cls || '') + '"><label>' + U.escapeHtml(label) + '</label>' + inner +
        (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
    },

    fieldsHtml: function () {
      var d = Entry.draft;
      var obj = Entry.object();
      var meta = svc(d.serviceId);
      var html = '';

      if (meta.kind === 'area') {
        var area = (d.area === null || d.area === undefined) ? obj.area : U.toNumber(d.area);
        var rate = (d.rate === null || d.rate === undefined) ? U.toNumber(obj.services[d.serviceId].rate) : U.toNumber(d.rate);
        html += '<div class="grid grid--3">' +
          Entry.fieldHtml('Площадь, м²', '<input type="number" name="area" step="0.01" min="0" inputmode="decimal" value="' + area + '">',
            'По реестру: ' + U.formatNumber(obj.area, 2) + ' м²') +
          Entry.fieldHtml('Тариф, ₽/м²', '<input type="number" name="rate" step="0.01" min="0" inputmode="decimal" value="' + rate + '">',
            'Из справочника: ' + U.formatNumber(obj.services[d.serviceId].rate, 2) + ' ₽/м²') +
          Entry.fieldHtml('Расчёт «на лету»', '<output class="calc-out">' + U.formatMoney(Engine.areaCharge(area, rate).total) + '</output>',
            U.formatNumber(area, 2) + ' × ' + U.formatNumber(rate, 2)) +
          '</div>';
      }

      if (meta.kind === 'fixed') {
        var m = Math.max(1, U.toNumber(d.months, 1));
        var fr = (d.rate === null || d.rate === undefined) ? U.toNumber(obj.services[d.serviceId].rate) : U.toNumber(d.rate);
        html += '<div class="grid grid--3">' +
          Entry.fieldHtml('Абонентская плата, ₽/мес.', '<input type="number" name="rate" step="0.01" min="0" inputmode="decimal" value="' + fr + '">',
            obj.services[d.serviceId].rate > 0 ? 'По реестру: ' + U.formatMoney(obj.services[d.serviceId].rate) : 'Услуга не подключена (0 ₽)') +
          Entry.fieldHtml('Количество месяцев', '<input type="number" name="months" step="1" min="1" value="' + m + '">', 'Например, оплата сразу за 3 месяца') +
          Entry.fieldHtml('Расчёт «на лету»', '<output class="calc-out">' + U.formatMoney(Engine.fixedCharge(fr, m).total) + '</output>',
            U.formatMoney(fr) + ' × ' + m) +
          '</div>';
      }

      if (d.serviceId === 'electricity' || d.serviceId === 'water') {
        var zones = Entry.zones();
        var unit = d.serviceId === 'electricity' ? 'кВтч' : 'м³';
        var decimals = d.serviceId === 'electricity' ? 1 : 3;
        var ms = State.meterState(d.objectId, d.serviceId, d.period);
        var readHtml = '<div class="grid grid--readings">';
        if (zones.length > 1) {
          zones.forEach(function (z) {
            var scale = Engine.getElectricityScale(obj.services.electricity.category, z);
            var curVal = d.readings[z];
            var prevVal = d.previous[z];
            readHtml += '<fieldset class="reading reading--' + z + '">' +
              '<legend>' + U.escapeHtml(scale ? scale.label : z) + ' <span class="muted-sm">' + U.escapeHtml(scale ? (scale.hours || '') : '') + '</span></legend>' +
              Entry.fieldHtml('Предыдущее показание, ' + unit, '<input type="number" name="prev' + cap(z) + '" step="0.001" min="0" inputmode="decimal" value="' + (prevVal === null || prevVal === undefined ? '' : prevVal) + '">') +
              Entry.fieldHtml('Текущее показание, ' + unit, '<input type="number" name="cur' + cap(z) + '" step="0.001" min="0" inputmode="decimal" value="' + (curVal === null || curVal === undefined ? '' : curVal) + '">') +
              '</fieldset>';
          });
        } else {
          readHtml += '<fieldset class="reading">' +
            '<legend>' + (d.serviceId === 'electricity' ? 'Одноставочный учёт' : 'Прибор учёта воды') + '</legend>' +
            Entry.fieldHtml('Предыдущее показание, ' + unit, '<input type="number" name="prevTotal" step="0.001" min="0" inputmode="decimal" value="' + (d.previous.total === null || d.previous.total === undefined ? '' : d.previous.total) + '">') +
            Entry.fieldHtml('Текущее показание, ' + unit, '<input type="number" name="curTotal" step="0.001" min="0" inputmode="decimal" value="' + (d.readings.total === null || d.readings.total === undefined ? '' : d.readings.total) + '">') +
            '</fieldset>';
        }
        readHtml += '<div class="reading-actions">' +
          '<button type="button" class="btn btn--ghost btn--sm" data-entry-action="fill-previous">↺ Подставить из журнала</button>' +
          '<span class="muted-sm">Источник: ' + (ms.source === 'journal' ? 'журнал начислений' : (ms.source === 'snapshot' ? 'последние показания' : 'нет данных')) +
          (ms.previousPeriod ? ' · предыдущий период ' + U.escapeHtml(U.periodLabelShort(ms.previousPeriod)) : '') + '</span>' +
          '</div></div>';
        html += readHtml;

        if (d.serviceId === 'water') {
          var key = d.waterRateKey || Engine.resolveWaterRateKey(obj, d.period, State.waterSchedule(obj.id)).rateKey;
          var fromSchedule = Engine.resolveWaterRateKey(obj, d.period, State.waterSchedule(obj.id));
          var archiveInfo = State.waterArchiveInfo(obj.id);
          html += '<div class="grid grid--2">' +
            Entry.fieldHtml('Тариф водоснабжения',
              '<select name="waterRateKey">' + Data.WATER_TARIFF_ORDER.map(function (k) {
                var t = Data.WATER_TARIFFS[k];
                return '<option value="' + k + '"' + (k === key ? ' selected' : '') + '>' + U.escapeHtml(t.label) + ' — ' + U.formatNumber(t.rate, 2) + ' ₽/м³</option>';
              }).join('') + '</select>',
              'По графику периодов для ' + U.periodLabelLower(d.period) + ' действует «' + U.escapeHtml(fromSchedule.label) + '» (' +
              U.formatNumber(fromSchedule.rate, 2) + ' ₽/м³)' + (fromSchedule.fromPeriod ? ', с ' + U.periodLabelLower(fromSchedule.fromPeriod) : '') +
              '. Выбор другого тарифа применится только к этой записи' +
              (d.waterRateKey ? ' — сейчас выбрано вручную: ' + U.formatNumber(Data.WATER_TARIFFS[d.waterRateKey].rate, 2) + ' ₽/м³' : '')) +
            Entry.fieldHtml('Объём потребления', '<output class="calc-out">' +
              U.formatNumber(Math.max(0, U.toNumber(d.readings.total) - U.toNumber(d.previous.total)), 3) + ' м³</output>',
              'Текущее − предыдущее показание') +
            '</div>' +
            (archiveInfo.hasArchive
              ? '<div class="ledger-note muted-sm">💧 Л/С Вода Крыма ' + U.escapeHtml(archiveInfo.account || 'уточняется') +
                ' · архив водомера: ' + archiveInfo.archive.length + ' ' + U.plural(archiveInfo.archive.length, 'запись', 'записи', 'записей') +
                ', последнее показание ' + U.formatNumber(archiveInfo.stats.lastReading, 2) + ' м³ (' + U.periodLabel(archiveInfo.stats.lastPeriod) + ')' +
                ' · средний расход ' + U.formatNumber(archiveInfo.stats.average, 2) + ' м³/мес</div>'
              : '');
        }
        if (d.serviceId === 'electricity') {
          html += '<div class="ledger-note muted-sm">Прибор учёта № ' + U.escapeHtml(obj.services.electricity.meter.serial) +
            ' · ' + U.escapeHtml(Data.ELECTRICITY_TARIFFS[obj.services.electricity.category].label) +
            ' · ' + (zones.length > 1 ? 'двухзонный (День/Ночь), лимиты ступеней применяются к каждой зоне независимо' : 'одноставочный') + '</div>';
        }
      }

      /* --- Секции/зоны распределения --- */
      html += '<div class="sections">' +
        '<div class="sections__head"><b>🏘️ Распределение начисления (необязательно)</b>' +
        '<span class="muted-sm">Например: 1-й этаж 70 м² и 2-й этаж 50 м², или доли жильцов по 2 и 3 человека (3 человека → 5 400 ₽).</span>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-entry-action="add-section">➕ Добавить секцию</button></div>' +
        (d.sections.length ? '<div class="sections__list">' + d.sections.map(function (s, i) {
          return '<div class="section-row" data-section-row data-index="' + i + '">' +
            '<input type="text" data-sec="name" value="' + U.escapeHtml(s.name || '') + '" placeholder="Название (10-й этаж, гараж, жильцы)" aria-label="Название секции">' +
            '<select data-sec="basis" aria-label="База распределения">' +
              '<option value="area"' + (s.basis === 'area' ? ' selected' : '') + '>площадь, м²</option>' +
              '<option value="points"' + (s.basis === 'points' ? ' selected' : '') + '>жильцы, чел.</option>' +
              '<option value="manual"' + (s.basis === 'manual' ? ' selected' : '') + '>фиксированная сумма, ₽</option>' +
            '</select>' +
            (s.basis === 'manual'
              ? '<input type="number" step="0.01" min="0" data-sec="manual" value="' + U.toNumber(s.manualAmount) + '" placeholder="Сумма, ₽" aria-label="Сумма">'
              : '<input type="number" step="0.01" min="0" data-sec="value" value="' + U.toNumber(s.value) + '" placeholder="Значение" aria-label="Значение">') +
            '<input type="number" step="1" min="0" max="100" data-sec="share" value="' + (s.share === undefined ? 100 : s.share) + '" placeholder="Доля, %" aria-label="Доля собственника, %">' +
            '<span class="section-row__amount" data-section-amount="' + i + '">—</span>' +
            '<button type="button" class="btn btn--icon btn--danger" data-entry-action="remove-section" data-index="' + i + '" title="Удалить секцию">✕</button>' +
          '</div>';
        }).join('') + '</div>' : '<div class="empty empty--sm">Начисление относится к объекту целиком.</div>') +
        '</div>';

      return html;
    },

    breakdownHtml: function () {
      var r = Entry.compute();
      var html = '';
      if (r.breakdown && r.breakdown.zones) {
        html += r.breakdown.zones.map(function (z) {
          return '<div class="bd"><div class="bd__head"><b>' + U.escapeHtml(z.label) + '</b>' +
            '<span class="muted-sm">' + U.formatNumber(z.consumption, 1) + ' кВтч · ' + U.formatMoney(z.total) + '</span></div>' +
            '<table class="table table--mini"><tbody>' + (z.rows.length ? z.rows.map(function (row) {
              return '<tr><td>' + U.escapeHtml(row.title || row.rangeLabel) + '<div class="muted-sm">' + U.formatNumber(row.volume, 1) + ' кВтч × ' + U.formatNumber(row.rate, 2) + ' ₽</div></td>' +
                '<td class="num">' + U.formatMoney(row.cost) + '</td></tr>';
            }).join('') : '<tr><td class="muted-sm" colspan="2">Расход 0 кВтч</td></tr>') + '</tbody></table></div>';
        }).join('');
      } else if (r.serviceId === 'water') {
        html += '<div class="bd"><div class="bd__head"><b>Водоснабжение</b><span class="muted-sm">' + r.formula + '</span></div></div>';
      }
      if (r.sectionPlan && r.sectionPlan.rows.length) {
        html += '<div class="bd"><div class="bd__head"><b>Распределение</b>' +
          '<span class="muted-sm">фикс. суммы ' + U.formatMoney(r.sectionPlan.manualTotal) + ' · остаток ' + U.formatMoney(r.sectionPlan.remainder) + '</span></div>' +
          '<table class="table table--mini"><tbody>' + r.sectionPlan.rows.map(function (row) {
            return '<tr><td>' + U.escapeHtml(row.name) +
              '<div class="muted-sm">' + (row.basis === 'manual' ? 'фиксированная сумма' :
                (row.basis === 'area' ? U.formatNumber(row.value, 2) + ' м²' : row.value + ' чел.') + ' × ' + U.formatNumber(row.share, 0) + '%') +
              '</div></td><td class="num"><b>' + U.formatMoney(row.amount) + '</b></td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      /* Обновляем суммы прямо в строках секций */
      if (r.sectionPlan && Entry.root) {
        r.sectionPlan.rows.forEach(function (row, i) {
          var host = $1('[data-section-amount="' + i + '"]', Entry.root);
          if (host) host.textContent = U.formatMoney(row.amount);
        });
      }
      return html;
    },

    updatePreview: function () {
      var root = Entry.root;
      if (!root) return;
      var r = Entry.compute();
      var host = $1('[data-entry-preview]', root);
      if (!host) return;

      var obj = Entry.object();
      var amountInput = $1('[name="amount"]', root);

      var warningsHtml = r.warnings.length
        ? '<ul class="warnings">' + r.warnings.map(function (w) { return '<li>⚠️ ' + U.escapeHtml(w) + '</li>'; }).join('') + '</ul>'
        : '';

      var walletLine = r.wallet.balance > 0
        ? 'Кошелёк «' + U.escapeHtml(r.meta.short) + '»: ' + U.formatMoney(r.wallet.balance) + ' → после списания ' +
          '<b>' + U.formatMoney(Math.max(0, r.wallet.after)) + '</b>' +
          (r.wallet.willBeDebt > 0 ? ' <span class="neg">(+ долг ' + U.formatMoney(r.wallet.willBeDebt) + ')</span>' : '')
        : (r.wallet.after < 0
          ? 'Начисление уйдёт в задолженность: <span class="neg">' + U.formatMoney(Math.abs(r.wallet.after)) + '</span>'
          : 'Аванс не внесён — начисление будет учтено как задолженность.');

      host.innerHTML =
        '<div class="preview__amount">' +
          '<span class="preview__label">Начислено за ' + U.escapeHtml(U.periodLabel(r.meta.kind === 'area' ? Entry.draft.period : Entry.draft.period)) + '</span>' +
          '<output class="preview__value">' + U.formatMoney(r.amount) + '</output>' +
          '<span class="preview__formula">' + U.escapeHtml(r.formula) + '</span>' +
          (Entry.draft.amountOverride !== null && !Entry.autoAmount ? '<span class="pill pill--warn">сумма изменена вручную</span>' : '<span class="pill pill--ok">авторасчёт</span>') +
        '</div>' +

        '<div class="preview__details">' +
          '<div class="kv"><span>Объект</span><b>№' + obj.index + ' ' + U.escapeHtml(obj.label) + '</b></div>' +
          '<div class="kv"><span>Площадь по реестру</span><b>' + U.formatNumber(obj.area, 2) + ' м²</b></div>' +
          r.details.map(function (d) { return '<div class="kv"><span>' + U.escapeHtml(d.label) + '</span><b>' + U.escapeHtml(d.value) + '</b></div>'; }).join('') +
          (r.consumption !== null && r.consumption !== undefined ? '<div class="kv"><span>Расход за период</span><b>' + U.formatNumber(r.consumption, r.serviceId === 'water' ? 3 : 1) + ' ' + (r.serviceId === 'water' ? 'м³' : 'кВтч') + '</b></div>' : '') +
          (r.consumption > 0 && r.amount > 0 ? '<div class="kv"><span>Средний тариф</span><b>' + U.formatNumber(r.amount / r.consumption, 2) + ' ₽ за ' + (r.serviceId === 'water' ? 'м³' : 'кВтч') + '</b></div>' : '') +
        '</div>' +

        '<div class="preview__wallet">💼 ' + walletLine +
          (r.wallet.forecastAfter && r.wallet.forecastAfter.hasForecast
            ? '<div class="forecast forecast--ok">' + U.escapeHtml(r.wallet.forecastAfter.text) + '</div>'
            : (r.wallet.monthly > 0 ? '<div class="forecast forecast--muted">Расчётный платёж по услуге: ' + U.formatMoney(r.wallet.monthly) + '/мес.</div>' : '')) +
        '</div>' +

        warningsHtml +

        '<div class="preview__actions">' +
          '<button type="button" class="btn btn--primary btn--lg" data-entry-action="save">💾 Сохранить в журнал</button>' +
          '<button type="button" class="btn btn--ghost" data-entry-action="reset">↺ Сбросить форму</button>' +
        '</div>';

      if (amountInput) {
        var value = Entry.draft.amountOverride !== null && !Entry.autoAmount ? Entry.draft.amountOverride : r.autoAmount;
        if (document.activeElement !== amountInput) amountInput.value = U.round(value, 2);
        amountInput.dataset.auto = (Entry.draft.amountOverride !== null && !Entry.autoAmount) ? '0' : '1';
      }
    },

    /* --- сохранение --------------------------------------------------------- */
    buildPayload: function (r) {
      var d = Entry.draft;
      var payload = {
        objectId: d.objectId,
        serviceId: d.serviceId,
        period: d.period,
        date: d.date || U.periodEndISO(d.period) || U.todayISO(),
        amount: U.round(r.amount, 2),
        amountSource: (d.amountOverride !== null && !Entry.autoAmount) ? 'manual' : 'auto',
        note: d.note || '',
        rate: r.rate,
        rateKey: r.rateKey || null,
        consumption: r.consumption,
        sections: (r.sectionPlan.rows.length ? r.sectionPlan.rows.map(function (row) {
          return { name: row.name, basis: row.basis, value: row.value, share: row.share, weight: U.round(row.weight, 4), amount: row.amount };
        }) : [])
      };
      if (r.breakdown) {
        payload.breakdown = r.breakdown;
        payload.readings = r.readings;
        payload.previousReadings = r.previous;
        payload.previousPeriod = U.addMonths(d.period, -1);
      }
      if (d.serviceId === 'maintenance' || d.serviceId === 'caprepair') {
        payload.rate = r.rate;
      }
      return payload;
    },

    save: function () {
      var r = Entry.compute();
      if (r.amount <= 0 && r.consumption === 0) {
        if (!global.confirm('Начисление равно 0 ₽. Всё равно сохранить запись?')) return;
      }
      var payload = Entry.buildPayload(r);
      var res = State.addEntry(payload);
      if (!res.ok && res.error === 'Дубликат') {
        var dup = res.duplicate;
        var ok = global.confirm('За ' + U.periodLabel(payload.period) + ' уже есть начисление по услуге «' + r.meta.label + '» для ' +
          Entry.object().label + ' на сумму ' + U.formatMoney(dup.amount) + '.\nЗаменить его новым значением ' + U.formatMoney(payload.amount) + '?');
        if (!ok) return;
        State.updateEntry(dup.id, payload);
        global.ZHKX.App && global.ZHKX.App.toast('Запись обновлена: ' + U.formatMoney(payload.amount), 'ok');
      } else if (res.ok) {
        global.ZHKX.App && global.ZHKX.App.toast('Начисление сохранено: ' + U.formatMoney(payload.amount) + ' · ' + r.meta.label, 'ok');
      } else {
        global.ZHKX.App && global.ZHKX.App.toast('Не удалось сохранить: ' + res.error, 'bad');
        return;
      }

      Entry.draft = Entry.defaultDraft();
      Entry.autoAmount = true;
      Entry.syncReadingsFromHistory();
      Entry.renderDynamic();
      Entry.updatePreview();
      global.ZHKX.App && global.ZHKX.App.refresh();
    }
  };

  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

  /* ------------------------------------------------------------ ВИД ФОРМЫ */
  function entryView() {
    var d = Entry.draft || (Entry.draft = Entry.defaultDraft());
    var obj = State.effectiveObject(d.objectId);
    var periodOptions = (function () {
      var out = [];
      for (var i = 1; i >= -6; i--) out.push(U.addMonths(U.currentPeriod(), i));
      if (out.indexOf(d.period) === -1) out.push(d.period);
      return out.sort().reverse();
    })();

    return '' +
      '<section class="section-head"><div><h2>🧮 Калькулятор начислений «на лету»</h2>' +
      '<p class="muted-sm">Выберите объект и услугу — система мгновенно рассчитает начисление по тарифам из data-слоя. ' +
      'Любое поле можно поправить вручную: тогда пометка «авторасчёт» сменится на «изменено вручную».</p></div></section>' +

      '<div class="entry-layout">' +
        '<form class="card entry-form" data-entry-form autocomplete="off">' +
          '<div class="grid grid--3">' +
            Entry.fieldHtml('Период начисления',
              '<input type="month" name="period" value="' + U.escapeHtml(d.period) + '" list="period-list">' +
              '<datalist id="period-list">' + periodOptions.map(function (p) { return '<option value="' + p + '">' + U.escapeHtml(U.periodLabel(p)) + '</option>'; }).join('') + '</datalist>',
              U.escapeHtml(U.periodLabel(d.period))) +
            Entry.fieldHtml('Объект',
              '<select name="objectId">' + State.effectiveObjects().map(function (o) {
                return '<option value="' + o.id + '"' + (o.id === d.objectId ? ' selected' : '') + '>№' + o.index + ' · ' + U.escapeHtml(o.label) + ' · Л/С ' + U.escapeHtml(o.account) + '</option>';
              }).join('') + '</select>',
              U.escapeHtml(obj.address.full)) +
            Entry.fieldHtml('Услуга',
              '<select name="serviceId">' + S.map(function (s) {
                var st = obj.services[s.id];
                var off = st && st.enabled === false;
                return '<option value="' + s.id + '"' + (s.id === d.serviceId ? ' selected' : '') + (off ? '' : '') + '>' + s.icon + ' ' + U.escapeHtml(s.label) + (off ? ' (не начисляется)' : '') + '</option>';
              }).join('') + '</select>',
              U.escapeHtml(svc(d.serviceId).hint)) +
          '</div>' +

          '<div class="grid grid--3">' +
            Entry.fieldHtml('Дата операции', '<input type="date" name="date" value="' + U.escapeHtml(d.date || U.periodEndISO(d.period) || U.todayISO()) + '">') +
            Entry.fieldHtml('Начислено, ₽ ' +
              '<label class="switch"><input type="checkbox" name="autoAmount"' + (Entry.autoAmount ? ' checked' : '') + '> авто</label>',
              '<input type="number" name="amount" step="0.01" min="0" inputmode="decimal" value="">',
              'Поле можно править вручную — авторежим отключится') +
            Entry.fieldHtml('Комментарий', '<input type="text" name="note" value="' + U.escapeHtml(d.note || '') + '" placeholder="например: показания переданы 25-го">') +
          '</div>' +

          '<div data-entry-fields></div>' +
          '<div data-entry-breakdown class="breakdowns"></div>' +
        '</form>' +

        '<aside class="card entry-preview" data-entry-preview aria-live="polite"></aside>' +
      '</div>';
  }

  /* --------------------------------------------------- МОДАЛЬНЫЕ ОКНА ---- */
  function depositModal(objId, serviceId) {
    var obj = State.effectiveObject(objId);
    var meta = svc(serviceId);
    var balance = State.balance(objId, serviceId);
    var history = State.entries({ objectId: objId, serviceId: serviceId });
    var expected = Engine.expectedMonthlyCharge(obj, serviceId, history);
    var body =
      '<div class="kv"><span>Объект</span><b>№' + obj.index + ' · ' + U.escapeHtml(obj.address.full) + '</b></div>' +
      '<div class="kv"><span>Услуга</span><b>' + meta.icon + ' ' + U.escapeHtml(meta.label) + '</b></div>' +
      '<div class="kv"><span>Текущий баланс</span><b>' + U.formatMoney(balance) + '</b></div>' +
      '<div class="kv"><span>Расчётный платёж</span><b>' + U.formatMoney(expected.amount) + '/мес.</b></div>' +
      '<form data-form="deposit" data-object="' + objId + '" data-service="' + serviceId + '" class="form-stack">' +
        '<div class="grid grid--3">' +
          Entry.fieldHtml('Сумма аванса, ₽', '<input type="number" name="amount" step="0.01" min="0" inputmode="decimal" required placeholder="5000">') +
          Entry.fieldHtml('Дата', '<input type="date" name="date" value="' + U.todayISO() + '">') +
          Entry.fieldHtml('Комментарий', '<input type="text" name="note" placeholder="Крупный аванс">') +
        '</div>' +
        '<div class="chip-row">' + [1000, 5000, 10000, 20000, 50000].map(function (v) {
          return '<button type="button" class="btn btn--chip" data-action="fill-deposit" data-amount="' + v + '">' + U.formatNumber(v, 0) + ' ₽</button>';
        }).join('') + '</div>' +
        '<div class="forecast-preview" data-deposit-preview></div>' +
        '<button class="btn btn--primary btn--lg" type="submit">💰 Внести аванс</button>' +
      '</form>';
    return {
      title: 'Аванс в кошелёк услуги',
      body: body,
      onMount: function (root) {
        var amountInput = $1('[name="amount"]', root);
        function refresh() {
          var v = U.toNumber(amountInput.value);
          var f = Engine.advanceForecast(balance + v, expected.amount, State.activePeriod());
          var host = $1('[data-deposit-preview]', root);
          if (host) host.innerHTML = f.hasForecast ? Views.pill('Прогноз', 'ok') + ' ' + U.escapeHtml(f.text) : '';
        }
        amountInput.addEventListener('input', refresh);
      }
    };
  }

  function areaModal(objId) {
    var obj = State.effectiveObject(objId);
    var base = Data.OBJECTS.filter(function (o) { return o.id === objId; })[0];
    return {
      title: 'Площадь объекта',
      body: '<form data-form="area" data-object="' + objId + '" class="form-stack">' +
        '<div class="kv"><span>Адрес</span><b>' + U.escapeHtml(obj.address.full) + '</b></div>' +
        (obj.areaNote ? '<div class="kv"><span>Основание</span><b>' + U.escapeHtml(obj.areaNote) + '</b></div>' : '') +
        Entry.fieldHtml('Общая площадь, м²', '<input type="number" name="area" step="0.01" min="0" inputmode="decimal" value="' + obj.area + '">',
          'Значение по умолчанию из реестра: ' + U.formatNumber(base.area, 2) + ' м²') +
        '<div class="muted-sm">Площадь используется для расчёта «Содержание МКД» и «Капитальный ремонт», а также для прогноза платежей.</div>' +
        '<div class="btn-row">' +
          '<button class="btn btn--primary" type="submit">Сохранить</button>' +
          '<button class="btn btn--ghost" type="button" data-action="reset-override" data-object="' + objId + '">Вернуть значение реестра</button>' +
        '</div>' +
        '</form>'
    };
  }

  function serviceModal(objId, serviceId) {
    var obj = State.effectiveObject(objId);
    var base = Data.OBJECTS.filter(function (o) { return o.id === objId; })[0];
    var meta = svc(serviceId);
    var s = obj.services[serviceId];
    var body = '';
    var fields = '';

    if (meta.kind === 'area') {
      fields = Entry.fieldHtml('Тариф, ₽/м²', '<input type="number" name="rate" step="0.01" min="0" inputmode="decimal" value="' + U.toNumber(s.rate) + '">',
        'По реестру: ' + U.formatNumber(base.services[serviceId].rate, 2) + ' ₽/м²');
    } else if (meta.kind === 'fixed') {
      fields = Entry.fieldHtml('Абонентская плата, ₽/мес.', '<input type="number" name="rate" step="0.01" min="0" inputmode="decimal" value="' + U.toNumber(s.rate) + '">',
        'По реестру: ' + U.formatMoney(base.services[serviceId].rate)) +
        Entry.fieldHtml('Услуга', '<select name="enabled"><option value="1"' + (s.enabled !== false ? ' selected' : '') + '>подключена</option>' +
          '<option value="0"' + (s.enabled === false ? ' selected' : '') + '>не подключена (0 ₽)</option></select>');
    } else if (serviceId === 'electricity') {
      fields = Entry.fieldHtml('Тарифная сетка (категория)',
        '<select name="category">' + Object.keys(Data.ELECTRICITY_TARIFFS).map(function (k) {
          var c = Data.ELECTRICITY_TARIFFS[k];
          return '<option value="' + k + '"' + (k === s.category ? ' selected' : '') + '>' + U.escapeHtml(c.label) + '</option>';
        }).join('') + '</select>',
        'По реестру: ' + U.escapeHtml(Data.ELECTRICITY_TARIFFS[base.services.electricity.category].label)) +
        Entry.fieldHtml('Зональность счётчика', '<select name="zones"><option value="1"' + (U.toNumber(s.zones, 1) === 1 ? ' selected' : '') + '>1 — одноставочный</option>' +
          '<option value="2"' + (U.toNumber(s.zones, 1) === 2 ? ' selected' : '') + '>2 — День/Ночь</option></select>');
      body += meterFieldsHtml(obj, 'electricity', base);
    } else if (serviceId === 'water') {
      var sched = Engine.resolveWaterRateKey(obj, State.activePeriod(), State.waterSchedule(objId));
      fields = Entry.fieldHtml('Лицевой счёт ГУП РК «Вода Крыма»',
          '<input type="text" name="waterAccount" value="' + U.escapeHtml(s.account || '') + '" placeholder="например 19050_ALU">',
          s.account ? '' : 'Уточните номер лицевого счёта (для объектов № 1 и № 6 данные уточняются)') +
        Entry.fieldHtml('Тариф по умолчанию',
          '<select name="rateKey">' + Data.WATER_TARIFF_ORDER.map(function (k) {
            var t = Data.WATER_TARIFFS[k];
            return '<option value="' + k + '"' + (k === (s.rateKey || Data.WATER_DEFAULT_RATE_KEY) ? ' selected' : '') + '>' +
              U.escapeHtml(t.label) + ' — ' + U.formatNumber(t.rate, 2) + ' ₽/м³</option>';
          }).join('') + '</select>',
          'Для ' + U.periodLabelLower(State.activePeriod()) + ' по графику действует «' + U.escapeHtml(sched.label) + '»: ' +
          U.formatNumber(sched.rate, 2) + ' ₽/м³') +
        Entry.fieldHtml('Архив водомера',
          '<output class="calc-out">' + ((s.archive || []).length
            ? (s.archive.length + ' ' + U.plural(s.archive.length, 'запись', 'записи', 'записей') + ' · последнее показание ' +
               U.formatNumber(Engine.archiveStats(s.archive, 3).lastReading, 2) + ' м³ (' + U.periodLabel(Engine.archiveStats(s.archive, 3).lastPeriod) + ')')
            : 'нет данных') + '</output>',
          'Архив задаётся в data-слое (config.js) и переносится в журнал в разделе «Водомеры»') +
        ((s.archive || []).length
          ? '<div class="btn-row"><button class="btn btn--ghost btn--sm" type="button" data-action="import-archive" data-object="' + objId + '">⬇️ Перенести архив в журнал</button>' +
            '<button class="btn btn--ghost btn--sm" type="button" data-action="open-archive" data-object="' + objId + '">💧 Открыть раздел «Водомеры»</button></div>'
          : '');
      body += meterFieldsHtml(obj, 'water', base);
    }

    return {
      title: meta.icon + ' ' + meta.label + ' — параметры объекта',
      body: '<form data-form="service" data-object="' + objId + '" data-service="' + serviceId + '" class="form-stack">' +
        '<div class="kv"><span>Объект</span><b>№' + obj.index + ' · ' + U.escapeHtml(obj.address.full) + '</b></div>' +
        (meta.kind === 'area' ? '<div class="muted-sm">Начисление = площадь × тариф, поэтому тариф влияет на все месяцы расчёта.</div>' : '') +
        fields + body +
        '<div class="btn-row">' +
          '<button class="btn btn--primary" type="submit">Сохранить</button>' +
          '<button class="btn btn--ghost" type="button" data-action="reset-override" data-object="' + objId + '" data-service="' + serviceId + '">Вернуть значения реестра</button>' +
        '</div></form>'
    };
  }

  function meterFieldsHtml(obj, serviceId, base) {
    var m = obj.services[serviceId].meter || {};
    var bm = (base.services[serviceId] && base.services[serviceId].meter) || {};
    return '<fieldset class="fieldset"><legend>Прибор учёта и госповерка</legend>' +
      '<div class="grid grid--2">' +
        Entry.fieldHtml('Номер счётчика', '<input type="text" name="meterSerial" value="' + U.escapeHtml(m.serial || '') + '">',
          bm.serial ? 'По реестру: ' + U.escapeHtml(bm.serial) : 'В реестре не указан — заполните из квитанции') +
        Entry.fieldHtml('Модель', '<input type="text" name="meterModel" value="' + U.escapeHtml(m.model || '') + '">',
          bm.model ? 'По реестру: ' + U.escapeHtml(bm.model) : '') +
        Entry.fieldHtml('Дата последней госповерки', '<input type="date" name="meterCheckDate" value="' + U.escapeHtml(m.lastCheckDate || '') + '">',
          bm.lastCheckDate ? 'По реестру: ' + U.formatDateDot(bm.lastCheckDate) : '') +
        Entry.fieldHtml('Межповерочный интервал, лет', '<input type="number" name="meterPeriodYears" step="1" min="1" value="' + (m.checkPeriodYears || '') + '">',
          bm.checkPeriodYears ? 'По реестру: ' + bm.checkPeriodYears + ' лет' : '') +
      '</div>' +
      '<div class="muted-sm">Дата следующей поверки рассчитывается автоматически: дата поверки + интервал.</div>' +
      '</fieldset>';
  }

  function meterModal(objId, serviceId) {
    var obj = State.effectiveObject(objId);
    var base = Data.OBJECTS.filter(function (o) { return o.id === objId; })[0];
    var meta = svc(serviceId);
    var st = Engine.verificationStatus(obj, serviceId);
    var s = obj.services[serviceId];
    var extra = serviceId === 'electricity'
      ? Entry.fieldHtml('Тарифная сетка (категория)',
          '<select name="category">' + Object.keys(Data.ELECTRICITY_TARIFFS).map(function (k) {
            return '<option value="' + k + '"' + (k === s.category ? ' selected' : '') + '>' + U.escapeHtml(Data.ELECTRICITY_TARIFFS[k].label) + '</option>';
          }).join('') + '</select>') +
        Entry.fieldHtml('Зональность счётчика', '<select name="zones"><option value="1"' + (U.toNumber(s.zones, 1) === 1 ? ' selected' : '') + '>1 — одноставочный</option>' +
          '<option value="2"' + (U.toNumber(s.zones, 1) === 2 ? ' selected' : '') + '>2 — День/Ночь</option></select>')
      : Entry.fieldHtml('Тариф воды', '<select name="rateKey">' + Data.WATER_TARIFF_ORDER.map(function (k) {
          var t = Data.WATER_TARIFFS[k];
          return '<option value="' + k + '"' + (k === (s.rateKey || Data.WATER_DEFAULT_RATE_KEY) ? ' selected' : '') + '>' + U.escapeHtml(t.label) + ' — ' + U.formatNumber(t.rate, 2) + ' ₽/м³</option>';
        }).join('') + '</select>');

    return {
      title: '⚙️ ' + meta.label + ' · прибор учёта',
      body: '<form data-form="meter" data-object="' + objId + '" data-service="' + serviceId + '" class="form-stack">' +
        '<div class="kv"><span>Объект</span><b>№' + obj.index + ' · ' + U.escapeHtml(obj.address.full) + '</b></div>' +
        '<div class="kv"><span>Текущий статус</span><b>' + st.icon + ' ' + U.escapeHtml(st.label) + '</b></div>' +
        '<div class="grid grid--2">' + extra + '</div>' +
        meterFieldsHtml(obj, serviceId, base) +
        '<div class="btn-row">' +
          '<button class="btn btn--primary" type="submit">Сохранить</button>' +
          '<button class="btn btn--ghost" type="button" data-action="reset-override" data-object="' + objId + '" data-service="' + serviceId + '">Вернуть значения реестра</button>' +
        '</div></form>'
    };
  }

  function entryEditModal(entryId) {
    var e = State.findEntry(entryId);
    if (!e) return null;
    var obj = State.effectiveObject(e.objectId);
    var meta = svc(e.serviceId);
    var periodOptions = (function () {
      var out = [];
      for (var i = 6; i >= -6; i--) out.push(U.addMonths(U.currentPeriod(), i));
      if (out.indexOf(e.period) === -1) out.push(e.period);
      return out.sort().reverse();
    })();
    return {
      title: '✏️ Изменить начисление',
      body: '<form data-form="entry-edit" data-entry="' + e.id + '" class="form-stack">' +
        '<div class="kv"><span>Объект</span><b>№' + obj.index + ' · ' + U.escapeHtml(obj.address.full) + '</b></div>' +
        '<div class="kv"><span>Услуга</span><b>' + meta.icon + ' ' + U.escapeHtml(meta.label) + '</b></div>' +
        '<div class="grid grid--3">' +
          Entry.fieldHtml('Период', '<select name="period">' + periodOptions.map(function (p) {
            return '<option value="' + p + '"' + (p === e.period ? ' selected' : '') + '>' + U.escapeHtml(U.periodLabel(p)) + '</option>';
          }).join('') + '</select>') +
          Entry.fieldHtml('Дата', '<input type="date" name="date" value="' + U.escapeHtml(e.date) + '">') +
          Entry.fieldHtml('Начислено, ₽', '<input type="number" name="amount" step="0.01" min="0" inputmode="decimal" value="' + U.toNumber(e.amount) + '">',
            e.amountSource === 'manual' ? 'Сумма задана вручную' : 'Сумма рассчитана автоматически') +
        '</div>' +
        '<div class="grid grid--2">' +
          Entry.fieldHtml('Комментарий', '<input type="text" name="note" value="' + U.escapeHtml(e.note || '') + '">') +
          (e.consumption !== null && e.consumption !== undefined
            ? Entry.fieldHtml('Расход', '<output class="calc-out">' + U.formatNumber(e.consumption, 3) + ' ' + (e.serviceId === 'water' ? 'м³' : (e.serviceId === 'electricity' ? 'кВтч' : '')) + '</output>')
            : '') +
        '</div>' +
        '<div class="muted-sm">Изменение суммы автоматически скорректирует движение в кошельке аванса.</div>' +
        '<div class="btn-row"><button class="btn btn--primary" type="submit">Сохранить</button>' +
        '<button class="btn btn--ghost" type="button" data-action="modal-close">Отмена</button></div>' +
        '</form>'
    };
  }

  var Forms = {
    Modal: Modal,
    Entry: Entry,
    entryView: entryView,
    computeSections: computeSections,
    depositModal: depositModal,
    areaModal: areaModal,
    serviceModal: serviceModal,
    meterModal: meterModal,
    entryEditModal: entryEditModal,
    fieldHtml: Entry.fieldHtml
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.Forms = Forms;
})(typeof window !== 'undefined' ? window : globalThis);
