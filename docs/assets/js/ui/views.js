/* ============================================================================
 *  UI / VIEWS — построение HTML всех разделов приложения
 *  ---------------------------------------------------------------------------
 *  Функции разметки чистые (state → HTML-строка), никаких обработчиков внутри:
 *  события навешиваются делегированием в ui/app.js по data-action.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Data = global.ZHKX.Data;
  var U = global.ZHKX.Utils;
  var Engine = global.ZHKX.TariffEngine;
  var State = global.ZHKX.State;
  var Analytics = global.ZHKX.Analytics;
  var S = Data.SERVICES;

  /* -------------------------------------------------------- ХЕЛПЕРЫ ------ */
  function svc(id) { return S.filter(function (s) { return s.id === id; })[0]; }

  function pill(text, kind, extraClass) {
    return '<span class="pill pill--' + (kind || 'neutral') + (extraClass ? ' ' + extraClass : '') + '">' + text + '</span>';
  }

  function money(value, decimals) {
    return '<span class="money">' + U.formatMoney(value, { decimals: decimals === undefined ? 2 : decimals }) + '</span>';
  }

  function progressBar(percent, kind) {
    var p = U.clamp(percent, 0, 100);
    return '<div class="progress" role="progressbar" aria-valuenow="' + p + '" aria-valuemin="0" aria-valuemax="100">' +
      '<div class="progress__bar progress__bar--' + (kind || 'ok') + '" style="width:' + p + '%"></div></div>';
  }

  function objectBadge(obj) {
    return '<span class="badge badge--obj">№' + obj.index + ' · ' + U.escapeHtml(obj.label) + '</span>';
  }

  function accountLine(obj) {
    var bits = ['Л/С ' + U.escapeHtml(obj.account || '—')];
    if (obj.els) bits.push('ЕЛС ' + U.escapeHtml(obj.els));
    return bits.join(' · ');
  }

  function verificationPill(status) {
    return '<span class="vstatus vstatus--' + status.css + '" title="' + U.escapeHtml(status.text) + '">' +
      status.icon + ' ' + U.escapeHtml(status.label) + '</span>';
  }

  function forecastBlock(text, kind) {
    return '<div class="forecast forecast--' + (kind || 'info') + '">📈 ' + U.escapeHtml(text) + '</div>';
  }

  /* =========================================================== KPI-БЛОК == */
  function kpiCards(k) {
    var deltaHtml = '';
    if (k.delta !== null) {
      var up = k.delta > 0;
      deltaHtml = '<span class="kpi__delta ' + (up ? 'kpi__delta--up' : 'kpi__delta--down') + '">' +
        (up ? '▲' : '▼') + ' ' + U.formatNumber(Math.abs(k.delta), 1) + '% к пред. месяцу</span>';
    }
    return '' +
      '<article class="kpi">' +
        '<div class="kpi__label">Начислено за ' + U.escapeHtml(k.periodLabel) + '</div>' +
        '<div class="kpi__value">' + U.formatMoney(k.currentTotal) + '</div>' +
        deltaHtml +
      '</article>' +
      '<article class="kpi">' +
        '<div class="kpi__label">Начислено с января ' + k.year + '</div>' +
        '<div class="kpi__value">' + U.formatMoney(k.yearTotal) + '</div>' +
        '<span class="kpi__delta">закрыто ' + k.monthsWithData + ' ' + U.plural(k.monthsWithData, 'месяц', 'месяца', 'месяцев') + '</span>' +
      '</article>' +
      '<article class="kpi kpi--ok">' +
        '<div class="kpi__label">Авансы в кошельках</div>' +
        '<div class="kpi__value">' + U.formatMoney(k.advanceTotal) + '</div>' +
        '<span class="kpi__delta">оплачено вперёд</span>' +
      '</article>' +
      '<article class="kpi ' + (k.debtTotal > 0 ? 'kpi--bad' : '') + '">' +
        '<div class="kpi__label">Задолженность</div>' +
        '<div class="kpi__value">' + U.formatMoney(k.debtTotal) + '</div>' +
        '<span class="kpi__delta">' + (k.debtTotal > 0 ? 'требуется оплата' : 'долгов нет') + '</span>' +
      '</article>' +
      '<article class="kpi ' + (k.expiredCount > 0 ? 'kpi--bad' : (k.warningCount > 0 ? 'kpi--warn' : 'kpi--ok')) + '">' +
        '<div class="kpi__label">Госповерка счётчиков</div>' +
        '<div class="kpi__value">' + k.expiredCount + ' / ' + k.verificationTotal + '</div>' +
        '<span class="kpi__delta">' + (k.expiredCount > 0 ? 'просрочено' : (k.warningCount > 0 ? k.warningCount + ' ' + U.plural(k.warningCount, 'требует', 'требуют', 'требуют') + ' внимания' : 'все в норме')) + '</span>' +
      '</article>';
  }

  function alertsPanel() {
    var list = Analytics.alerts();
    if (!list.length) {
      return '<div class="empty empty--ok">✅ Проблем не обнаружено: все начисления внесены, поверки в норме.</div>';
    }
    return '<ul class="alerts">' + list.map(function (a) {
      return '<li class="alert alert--' + a.level + '">' +
        '<span class="alert__icon">' + a.icon + '</span>' +
        '<div class="alert__body"><b>' + U.escapeHtml(a.title) + '</b><span>' + U.escapeHtml(a.text) + '</span></div>' +
        (a.objectId ? '<button class="btn btn--ghost btn--sm" data-action="goto-object" data-object="' + a.objectId + '"' +
          (a.serviceId ? ' data-service="' + a.serviceId + '"' : '') + '>Открыть →</button>' : '') +
        '</li>';
    }).join('') + '</ul>';
  }

  /* ============================================================= ОБЪЕКТЫ == */
  function serviceRowHtml(obj, serviceId, period, item) {
    var meta = svc(serviceId);
    var s = obj.services[serviceId];
    var enabled = s.enabled !== false;
    var charge = Analytics.summaryForPeriod(period, { objectId: obj.id }).byService[serviceId] || 0;

    var rateText, rateUnit;
    if (meta.kind === 'area') { rateText = U.formatNumber(s.rate, 2) + ' ₽/м²'; rateUnit = 'площадь ' + U.formatNumber(obj.area, 2) + ' м²'; }
    else if (meta.kind === 'fixed') { rateText = U.formatMoney(s.rate) + '/мес.'; rateUnit = enabled ? 'абонентская плата' : 'услуга не подключена'; }
    else if (serviceId === 'electricity') { rateText = 'сетка «' + Data.ELECTRICITY_TARIFFS[s.category].label + '»'; rateUnit = (s.zones >= 2 ? 'День/Ночь' : 'одноставочный') + ' · № ' + (s.meter.serial || '—'); }
    else if (serviceId === 'water') {
      var t = Data.WATER_TARIFFS[s.rateKey || Data.WATER_DEFAULT_RATE_KEY];
      rateText = U.formatNumber(t.rate, 2) + ' ₽/м³'; rateUnit = t.label;
    }

    return '<tr class="' + (enabled ? '' : 'is-muted') + '">' +
      '<td><span class="svc"><i style="background:' + meta.color + '"></i>' + meta.icon + ' ' + U.escapeHtml(meta.label) + '</span></td>' +
      '<td>' + U.escapeHtml(rateText) + '<div class="muted-sm">' + U.escapeHtml(rateUnit) + '</div></td>' +
      '<td class="num">' + (charge > 0 ? money(charge) : '<span class="muted-sm">—</span>') + '</td>' +
      '<td class="num">' + (item ? (item.advance > 0 ? '<span class="pos">' + U.formatMoney(item.advance) + '</span>' :
        (item.debt > 0 ? '<span class="neg">−' + U.formatMoney(item.debt) + '</span>' : '<span class="muted-sm">0,00 ₽</span>')) : '—') + '</td>' +
      '<td class="col-actions">' +
        '<button class="btn btn--ghost btn--sm" data-action="add-deposit" data-object="' + obj.id + '" data-service="' + serviceId + '">💰 Аванс</button>' +
        '<button class="btn btn--ghost btn--sm" data-action="edit-service" data-object="' + obj.id + '" data-service="' + serviceId + '">⚙️</button>' +
      '</td>' +
      '</tr>';
  }

  function meterBlock(obj, serviceId, nowISO) {
    var s = obj.services[serviceId];
    var status = Engine.verificationStatus(obj, serviceId, nowISO);
    var isEl = serviceId === 'electricity';
    var title = isEl ? '⚡ Счётчик электроэнергии' : '💧 Прибор учёта воды';
    var rows = [];

    if (status.hasData) {
      rows.push('<div class="kv"><span>Прибор учёта</span><b>№ ' + U.escapeHtml(status.serial || '—') + '</b></div>');
      if (status.model) rows.push('<div class="kv"><span>Модель</span><b>' + U.escapeHtml(status.model) + '</b></div>');
      rows.push('<div class="kv"><span>Зональность</span><b>' + (s.zones >= 2 ? '2 (День/Ночь)' : '1 (одноставочный)') + '</b></div>');
      if (isEl) rows.push('<div class="kv"><span>Категория тарифа</span><b>' + U.escapeHtml(Data.ELECTRICITY_TARIFFS[s.category].label) + '</b></div>');
      rows.push('<div class="kv"><span>Последняя госповерка</span><b>' + U.formatDateISO(status.lastCheckDate) + '</b></div>');
      rows.push('<div class="kv"><span>Межповерочный интервал</span><b>' + status.periodYears + ' ' + U.plural(status.periodYears, 'год', 'года', 'лет') + '</b></div>');
      rows.push('<div class="kv"><span>Следующая поверка</span><b class="' + (status.css === 'ok' ? '' : 'neg') + '">' + U.formatDateISO(status.nextCheckDate) + '</b></div>');
    } else {
      rows.push('<div class="empty empty--sm">' + U.escapeHtml(s.meter && s.meter.note ? s.meter.note : 'Данные прибора учёта не заполнены.') + '</div>');
    }

    return '<div class="meter">' +
      '<div class="meter__head">' +
        '<span>' + title + '</span>' +
        verificationPill(status) +
      '</div>' +
      (status.hasData ? progressBar(status.progressPercent, status.css) : '') +
      '<div class="meter__rows">' + rows.join('') + '</div>' +
      (status.hasData ? '<div class="muted-sm">' + U.escapeHtml(status.text) + '</div>' : '') +
      '<button class="btn btn--ghost btn--sm" data-action="edit-meter" data-object="' + obj.id + '" data-service="' + serviceId + '">⚙️ Настроить прибор учёта</button>' +
      '</div>';
  }

  /** Строка «Водоснабжение»: лицевой счёт Вода Крыма + тариф + архив водомера */
  function waterLine(obj) {
    var w = obj.services.water;
    var archive = w.archive || [];
    var stats = archive.length ? Engine.archiveStats(archive, Data.RULES.forecastWindowMonths) : null;
    var resolved = Engine.resolveWaterRateKey(obj, State.activePeriod(), State.waterSchedule(obj.id));
    var accountText = w.account
      ? 'Л/С Вода Крыма № ' + U.escapeHtml(w.account)
      : 'Л/С Вода Крыма: ' + U.escapeHtml(w.accountNote || 'данные уточняются');

    return '<div class="water-line">' +
      '<div class="wl__main"><span aria-hidden="true">💧</span> ' + accountText +
        '<span class="pill pill--chip">тариф ' + U.formatNumber(resolved.rate, 2) + ' ₽/м³ · ' + U.escapeHtml(resolved.label) + '</span>' +
        (archive.length ? '<span class="pill pill--ok">архив: ' + archive.length + ' ' + U.plural(archive.length, 'запись', 'записи', 'записей') + '</span>' : '') +
      '</div>' +
      (stats ? '<div class="muted-sm">История водомера: ' + U.formatDateISO(stats.firstPeriod + '-01').replace(' г.', '') + ' → ' +
        U.periodLabelShort(stats.lastPeriod) +
        ' · последнее показание ' + U.formatNumber(stats.lastReading, 2) + ' м³' +
        ' · средний расход ' + U.formatNumber(stats.average, 2) + ' м³/мес (последние 3 записи)' +
        ' · всего израсходовано ' + U.formatNumber(stats.totalConsumption, 1) + ' м³</div>' : '') +
      '</div>';
  }

  function objectCard(obj, nowISO) {
    var period = State.activePeriod();
    var wallet = Analytics.walletFor(obj.id);
    var walletByService = wallet.reduce(function (acc, w) { acc[w.serviceId] = w; return acc; }, {});
    var summary = Analytics.summaryForPeriod(period, { objectId: obj.id });
    var totalAdvance = U.sum(wallet, function (w) { return w.advance; });
    var totalDebt = U.sum(wallet, function (w) { return w.debt; });

    var serviceRows = S.map(function (meta) {
      return serviceRowHtml(obj, meta.id, period, walletByService[meta.id]);
    }).join('');

    var forecasts = wallet.filter(function (w) {
      return w.advance > 0.5;
    }).map(function (w) {
      return '<li>' + w.icon + ' <b>' + U.escapeHtml(w.short) + '</b>: ' + U.escapeHtml(w.forecast.text) + '</li>';
    });

    var meterForecasts = ['electricity', 'water'].map(function (sid) {
      var mf = Analytics.meterForecast(obj.id, sid);
      var sourceBadge = mf.source === 'archive' ? ' ' + pill('архив водомера', 'ok')
        : (mf.source === 'mixed' ? ' ' + pill('журнал + архив', 'neutral') : '');
      return '<li>' + (sid === 'electricity' ? '⚡' : '💧') + ' <b>' + (sid === 'electricity' ? 'Электроэнергия' : 'Вода') + '</b>' +
        sourceBadge + ': ' + U.escapeHtml(mf.text) + '</li>';
    });

    return '<article class="card card--object" id="object-' + obj.id + '" data-object-card="' + obj.id + '">' +
      '<header class="card__head">' +
        '<div>' +
          '<h3>' + objectBadge(obj) + ' ' + U.escapeHtml(obj.label) + '</h3>' +
          '<div class="muted-sm">' + U.escapeHtml(obj.address.full) + '</div>' +
          '<div class="muted-sm">' + accountLine(obj) + ' · собственник: ' + U.escapeHtml(obj.owner) + '</div>' +
        '</div>' +
        '<div class="card__head-right">' +
          '<div class="chip"><span>Площадь</span><b>' + U.formatNumber(obj.area, 2) + ' м²</b>' +
            (obj.isAreaOverridden ? pill('правка', 'warn') : '') +
            '<button class="btn btn--icon" data-action="edit-area" data-object="' + obj.id + '" title="Изменить площадь">✏️</button></div>' +
          '<div class="chip chip--money"><span>Начислено за ' + U.escapeHtml(U.periodLabelShort(period)) + '</span><b>' + U.formatMoney(summary.total) + '</b></div>' +
        '</div>' +
      '</header>' +

      (obj.management ? '<div class="muted-sm">Управляющая организация: ' + U.escapeHtml(obj.management) + '</div>' : '') +
      (obj.notes && obj.notes.length ? '<ul class="notes">' + obj.notes.map(function (n) { return '<li>' + U.escapeHtml(n) + '</li>'; }).join('') + '</ul>' : '') +

      '<div class="table-wrap"><table class="table table--services">' +
        '<thead><tr><th>Услуга</th><th>Тариф</th><th class="num">Начислено, ' + U.escapeHtml(U.periodLabelShort(period)) + '</th><th class="num">Аванс / долг</th><th></th></tr></thead>' +
        '<tbody>' + serviceRows + '</tbody>' +
      '</table></div>' +

      waterLine(obj) +
      '<div class="wallet-summary">' +
        '<div class="ws ws--adv"><span>Авансы</span><b>' + U.formatMoney(totalAdvance) + '</b></div>' +
        '<div class="ws ws--debt"><span>Долг</span><b>' + U.formatMoney(totalDebt) + '</b></div>' +
        '<div class="ws ws--month"><span>Расчётный платёж по капремонту</span><b>' +
          U.formatMoney(U.toNumber(obj.area) * U.toNumber(obj.services.caprepair.rate)) + '/мес.</b></div>' +
      '</div>' +

      '<div class="meters">' + meterBlock(obj, 'electricity', nowISO) + meterBlock(obj, 'water', nowISO) + '</div>' +

      (forecasts.length || meterForecasts.length ?
        '<div class="forecasts"><h4>Прогнозы</h4><ul>' + forecasts.join('') + meterForecasts.join('') + '</ul></div>' : '') +

      '<footer class="card__foot">' +
        '<button class="btn btn--primary btn--sm" data-action="quick-entry" data-object="' + obj.id + '">➕ Добавить начисления</button>' +
        (obj.services.water.archive && obj.services.water.archive.length
          ? '<button class="btn btn--ghost btn--sm" data-action="open-archive" data-object="' + obj.id + '">💧 Архив водомера (' + obj.services.water.archive.length + ')</button>'
          : '') +
        '<button class="btn btn--ghost btn--sm" data-action="tariff-periods" data-object="' + obj.id + '">🗓️ Тарифы воды по периодам</button>' +
        '<button class="btn btn--ghost btn--sm" data-action="open-wallet" data-object="' + obj.id + '">💰 Кошелёк авансов</button>' +
        '<button class="btn btn--ghost btn--sm" data-action="journal-for" data-object="' + obj.id + '">🧾 Журнал</button>' +
        '</footer>' +
      '</article>';
  }

  function objectsView(nowISO) {
    var list = State.effectiveObjects();
    return '' +
      '<section class="section-head">' +
        '<div><h2>🏠 Реестр объектов и приборов учёта</h2>' +
        '<p class="muted-sm">6 объектов · данные жёстко зашиты в <code>assets/js/data/config.js</code> (Source of Truth). Любое поле можно скорректировать — правка сохранится в localStorage и будет иметь приоритет над базой.</p></div>' +
        '<div class="section-head__actions">' +
          '<button class="btn btn--ghost btn--sm" data-action="expand-all">Развернуть карточки</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="collapse-all">Свернуть</button>' +
        '</div>' +
      '</section>' +
      '<div class="objects-grid">' + list.map(function (o) { return objectCard(o, nowISO); }).join('') + '</div>';
  }

  /* ============================================================ ДАШБОРД == */
  function dashboardView(state, nowISO) {
    var period = State.activePeriod();
    var filterId = State.getSetting('dashObjectFilter', null);
    var k = Analytics.kpi(filterId);
    var filterObj = filterId ? State.effectiveObject(filterId) : null;
    var totals = Analytics.objectTotals(period).filter(function (t) { return !filterId || t.objectId === filterId; });
    var series = Analytics.periodSeries({ months: 12, objectId: filterId });
    var monthsWithData = series.filter(function (s) { return s.hasData; }).length;

    var filterChips = '<div class="chip-row chip-row--filter">' +
      '<button class="btn btn--chip' + (!filterId ? ' is-active' : '') + '" data-action="dash-filter" data-object="">Все объекты</button>' +
      Data.OBJECTS.map(function (o) {
        return '<button class="btn btn--chip' + (filterId === o.id ? ' is-active' : '') + '" data-action="dash-filter" data-object="' + o.id + '">№' + o.index + ' · ' + U.escapeHtml(o.label) + '</button>';
      }).join('') + '</div>';

    var rows = totals.map(function (t) {
      var wallet = Analytics.walletFor(t.objectId);
      var forecasts = wallet.filter(function (w) { return w.advance > 0.5 && w.forecast.hasForecast; });
      var closest = forecasts.sort(function (a, b) { return a.forecast.months - b.forecast.months; })[0];
      return '<tr>' +
        '<td><b>№' + t.index + '</b> ' + U.escapeHtml(t.label) + '<div class="muted-sm">' + U.escapeHtml(t.address) + '</div></td>' +
        '<td class="num">' + money(t.total) + '</td>' +
        '<td class="num">' + (wallet.length ? U.formatMoney(t.advanceTotal) : '—') + '</td>' +
        '<td class="num">' + (t.debtTotal > 0 ? '<span class="neg">' + U.formatMoney(t.debtTotal) + '</span>' : '—') + '</td>' +
        '<td>' + (t.filled ? pill('внесено', 'ok') : pill('нет записей', 'warn')) + '</td>' +
        '<td class="muted-sm">' + (closest ? U.escapeHtml(closest.short + ': ' + closest.forecast.monthsLabel + ' мес.') : '—') + '</td>' +
      '</tr>';
    }).join('');

    var currentPeriod = U.currentPeriod();
    var periodNote = period !== currentPeriod
      ? '<div class="forecast forecast--info">🗓️ Показан ' + U.escapeHtml(U.periodLabelLower(period)) +
        ' — последний месяц с начислениями. За ' + U.escapeHtml(U.periodLabelLower(currentPeriod)) +
        ' записей пока нет: добавьте показания в разделе «Калькулятор».</div>'
      : '';

    return '' +
      filterChips +
      periodNote +
      '<section class="kpi-grid">' + kpiCards(k) + '</section>' +

      '<section class="grid grid--2">' +
        '<article class="card">' +
          '<header class="card__head"><h3>📊 ' + (filterId ? 'Расходы по услугам' : 'Структура расходов по объектам') + ' за ' + U.escapeHtml(U.periodLabelLower(period)) + '</h3>' +
          '<span class="muted-sm">' + (filterObj ? U.escapeHtml(filterObj.address.full) + ' · ' : '') +
          'всего ' + U.formatMoney(Analytics.summaryForPeriod(period, filterId ? { objectId: filterId } : {}).total) + '</span></header>' +
          '<div class="chart-box chart-box--doughnut"><canvas id="chart-service" aria-label="Структура расходов по услугам" role="img"></canvas></div>' +
          '<div class="legend" id="legend-service"></div>' +
        '</article>' +
        '<article class="card">' +
          '<header class="card__head"><h3>🏠 Начисления по объектам</h3><span class="muted-sm">' + U.escapeHtml(U.periodLabelShort(period)) + '</span></header>' +
          '<div class="chart-box chart-box--doughnut"><canvas id="chart-object" aria-label="Начисления по объектам" role="img"></canvas></div>' +
          '<div class="legend" id="legend-object"></div>' +
        '</article>' +
      '</section>' +

      '<section class="card">' +
        '<header class="card__head"><h3>📈 Динамика начислений по месяцам</h3>' +
        '<div class="btn-group">' +
          '<button class="btn btn--ghost btn--sm" data-action="chart-months" data-months="6">6 мес.</button>' +
          '<button class="btn btn--ghost btn--sm is-active" data-action="chart-months" data-months="12">12 мес.</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="chart-months" data-months="24">24 мес.</button>' +
        '</div></header>' +
        '<div class="chart-box"><canvas id="chart-monthly" aria-label="Динамика начислений" role="img"></canvas></div>' +
        '<div class="muted-sm">Закрыто ' + monthsWithData + ' ' + U.plural(monthsWithData, 'месяц', 'месяца', 'месяцев') + ' из 12 в окне анализа. ' +
        'Всего записей в журнале: ' + k.journalCount + '.</div>' +
      '</section>' +

      '<section class="grid grid--2">' +
        '<article class="card">' +
          '<header class="card__head"><h3>🔎 Мониторинг и оповещения</h3>' +
          '<button class="btn btn--ghost btn--sm" data-action="tab" data-view="verification">Госповерка →</button></header>' +
          alertsPanel() +
        '</article>' +
        '<article class="card">' +
          '<header class="card__head"><h3>🗂️ Сводка по объектам</h3><span class="muted-sm">' + U.escapeHtml(U.periodLabel(period)) + '</span></header>' +
          '<div class="table-wrap"><table class="table">' +
            '<thead><tr><th>Объект</th><th class="num">Начислено</th><th class="num">Аванс</th><th class="num">Долг</th><th>Период</th><th>Ближайший прогноз</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table></div>' +
        '</article>' +
      '</section>';
  }

  /* ============================================================== АВАНСЫ == */
  function movementsTable(objId, serviceId) {
    var list = State.movementsOf({ objectId: objId, serviceId: serviceId }).slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id));
    });
    if (!list.length) return '<div class="empty empty--sm">Движений по услуге пока нет.</div>';
    return '<div class="table-wrap"><table class="table table--compact">' +
      '<thead><tr><th>Дата</th><th>Тип</th><th class="num">Сумма</th><th>Комментарий</th><th></th></tr></thead><tbody>' +
      list.map(function (m) {
        var kind = State.MOVEMENT_KINDS[m.kind];
        var sign = m.amount < 0 ? '−' : '+';
        return '<tr>' +
          '<td>' + U.formatDateDot(m.date) + '</td>' +
          '<td>' + kind.icon + ' ' + U.escapeHtml(kind.label) + (m.period ? ' <span class="muted-sm">' + m.period + '</span>' : '') + '</td>' +
          '<td class="num ' + (m.amount < 0 ? 'neg' : 'pos') + '">' + sign + U.formatMoney(Math.abs(m.amount)) + '</td>' +
          '<td class="muted-sm">' + U.escapeHtml(m.note || '—') + '</td>' +
          '<td><button class="btn btn--icon btn--danger" title="Удалить движение" data-action="delete-movement" data-movement="' + m.id + '">✕</button></td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function walletCard(obj, item) {
    var f = item.forecast;
    var depositForm =
      '<form class="inline-form" data-form="deposit" data-object="' + obj.id + '" data-service="' + item.serviceId + '">' +
        '<div class="field">' +
          '<label>Внести крупный аванс, ₽</label>' +
          '<input type="number" step="0.01" min="0" name="amount" placeholder="например 5000" inputmode="decimal" required>' +
        '</div>' +
        '<div class="field field--date">' +
          '<label>Дата</label>' +
          '<input type="date" name="date" value="' + U.todayISO() + '">' +
        '</div>' +
        '<div class="field field--grow">' +
          '<label>Комментарий</label>' +
          '<input type="text" name="note" placeholder="Крупный аванс">' +
        '</div>' +
        '<button class="btn btn--primary" type="submit">💰 Пополнить кошелёк</button>' +
      '</form>';

    var quick = [1000, 5000, 10000, 20000].map(function (v) {
      return '<button type="button" class="btn btn--chip" data-action="fill-deposit" data-object="' + obj.id + '" data-service="' + item.serviceId + '" data-amount="' + v + '">' + U.formatNumber(v, 0) + ' ₽</button>';
    }).join('');

    return '<article class="card card--wallet' + (item.advance > 0 ? ' is-funded' : '') + '">' +
      '<header class="card__head">' +
        '<h3><span class="dot" style="background:' + item.color + '"></span>' + item.icon + ' ' + U.escapeHtml(item.label) + '</h3>' +
        '<div class="wallet-amount">' +
          (item.advance > 0 ? '<b class="pos">' + U.formatMoney(item.advance) + '</b><span class="muted-sm">остаток аванса</span>'
            : (item.debt > 0 ? '<b class="neg">−' + U.formatMoney(item.debt) + '</b><span class="muted-sm">задолженность</span>'
              : '<b>0,00 ₽</b><span class="muted-sm">сальдо</span>')) +
        '</div>' +
      '</header>' +
      '<div class="wallet-meta">' +
        '<div class="kv"><span>Расчётный платёж</span><b>' + U.formatMoney(item.monthly) + '/мес.</b></div>' +
        '<div class="kv"><span>Основание</span><b>' + U.escapeHtml(basisLabel(item)) + '</b></div>' +
      '</div>' +
      (f.hasForecast ? forecastBlock(f.text, f.months < 1 ? 'warn' : 'ok') :
        (f.reason === 'empty' ? '<div class="forecast forecast--muted">Аванс не внесён. Внесите сумму — система рассчитает, на сколько месяцев её хватит.</div>'
          : '<div class="forecast forecast--muted">' + U.escapeHtml(f.text) + '</div>')) +
      '<div class="chip-row">' + quick + '</div>' +
      depositForm +
      movementsTable(obj.id, item.serviceId) +
      '</article>';
  }

  function basisLabel(item) {
    if (item.monthlyBasis === 'area') return item.monthlyDetail.formula;
    if (item.monthlyBasis === 'fixed') return item.monthlyDetail.formula;
    if (item.monthlyBasis === 'meter_average') return item.monthlyDetail.formula;
    if (item.monthlyBasis === 'no_history') return 'нет истории для усреднения (нужно ≥ 1 закрытого месяца)';
    return '—';
  }

  function walletView() {
    var filterId = State.getSetting('walletFilterObject', null);
    var objects = State.effectiveObjects().filter(function (o) { return !filterId || o.id === filterId; });
    var totals = Analytics.walletsSummary();

    return '' +
      '<section class="section-head">' +
        '<div><h2>💰 Депозитные кошельки (авансы)</h2>' +
        '<p class="muted-sm">Крупный аванс привязывается к услуге. Каждое новое начисление в журнале автоматически уменьшает остаток аванса этого кошелька (движение «Начисление» со знаком «минус»).</p></div>' +
        '<div class="section-head__actions">' +
          '<div class="totals-inline">' +
            '<span class="pill pill--ok">Авансы: ' + U.formatMoney(totals.advanceTotal) + '</span>' +
            '<span class="pill ' + (totals.debtTotal > 0 ? 'pill--bad' : 'pill--neutral') + '">Долги: ' + U.formatMoney(totals.debtTotal) + '</span>' +
          '</div>' +
        '</div>' +
      '</section>' +
      objects.map(function (obj) {
        var items = Analytics.walletFor(obj.id);
        return '<section class="wallet-object" id="wallet-' + obj.id + '">' +
          '<header class="wallet-object__head">' +
            '<h3>' + objectBadge(obj) + ' ' + U.escapeHtml(obj.address.full) + '</h3>' +
            '<div class="muted-sm">' + accountLine(obj) + ' · ' + U.escapeHtml(obj.owner) + ' · ' + U.formatNumber(obj.area, 2) + ' м²</div>' +
          '</header>' +
          '<div class="wallet-grid">' + items.map(function (item) {
            return walletCard(obj, item);
          }).join('') + '</div>' +
        '</section>';
      }).join('');
  }

  /* ============================================================= ЖУРНАЛ == */
  function journalView(filters) {
    var f = filters || {};
    var list = State.entries(f);

    /* Живой текстовый поиск: адрес, лицевой счёт, услуга, комментарий, сумма, период */
    if (f.q) {
      var needle = U.normalizeText(f.q);
      list = list.filter(function (e) {
        var obj = State.effectiveObject(e.objectId);
        var meta = svc(e.serviceId);
        var haystack = [
          obj.address.full, obj.owner, obj.account, obj.els, obj.label,
          meta.label, meta.short, e.note, e.period, U.periodLabel(e.period),
          U.formatNumber(e.amount, 2), String(e.amount)
        ].join(' ');
        return U.normalizeText(haystack).indexOf(needle) !== -1;
      });
    }

    var totalAmount = U.sum(list, function (e) { return e.amount; });
    var totalsByService = {};
    list.forEach(function (e) {
      totalsByService[e.serviceId] = U.round((totalsByService[e.serviceId] || 0) + e.amount, 2);
    });

    var periodOptions = (function () {
      var set = {};
      State.entries({}).forEach(function (e) { set[e.period] = true; });
      set[U.currentPeriod()] = true;
      return Object.keys(set).sort().reverse();
    })();

    var filtersHtml =
      '<div class="filters">' +
        '<div class="field"><label>Объект</label><select name="objectId" data-filter="objectId">' +
          '<option value="">Все объекты</option>' +
          Data.OBJECTS.map(function (o) {
            return '<option value="' + o.id + '"' + (f.objectId === o.id ? ' selected' : '') + '>№' + o.index + ' · ' + U.escapeHtml(o.label) + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field"><label>Услуга</label><select name="serviceId" data-filter="serviceId">' +
          '<option value="">Все услуги</option>' +
          S.map(function (s) {
            return '<option value="' + s.id + '"' + (f.serviceId === s.id ? ' selected' : '') + '>' + s.icon + ' ' + U.escapeHtml(s.label) + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field"><label>Период</label><select name="period" data-filter="period">' +
          '<option value="">Все периоды</option>' +
          periodOptions.map(function (p) {
            return '<option value="' + p + '"' + (f.period === p ? ' selected' : '') + '>' + U.escapeHtml(U.periodLabel(p)) + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field field--grow"><label>Поиск</label><input type="search" name="q" data-filter="q" value="' + U.escapeHtml(f.q || '') + '" placeholder="адрес, счёт, комментарий, сумма…"></div>' +
        '<button class="btn btn--ghost" data-action="journal-reset">Сбросить</button>' +
      '</div>';

    var rows = list.map(function (e) {
      var obj = State.effectiveObject(e.objectId);
      var meta = svc(e.serviceId);
      var coverage = null;
      var covMap = State.coverageMap(e.objectId, e.serviceId);
      coverage = covMap[e.id] || null;

      var detail = '';
      if (e.serviceId === 'electricity' && e.breakdown && e.breakdown.zones) {
        detail = '<div class="breakdown">' + e.breakdown.zones.map(function (z) {
          return '<div class="breakdown__zone"><b>' + U.escapeHtml(z.label) + '</b> <span class="muted-sm">' + U.escapeHtml(z.hours || '') + '</span>' +
            '<table class="table table--mini"><tbody>' + z.rows.map(function (r) {
              return '<tr><td>' + U.escapeHtml(r.title || r.rangeLabel) + '</td><td class="num">' + U.formatNumber(r.volume, 1) + ' кВтч</td>' +
                '<td class="num">× ' + U.formatNumber(r.rate, 2) + ' ₽</td><td class="num">' + U.formatMoney(r.cost) + '</td></tr>';
            }).join('') +
            '<tr class="sum"><td colspan="3">Итого по зоне «' + U.escapeHtml(z.label) + '»</td><td class="num">' + U.formatMoney(z.total) + '</td></tr>' +
            '</tbody></table></div>';
        }).join('') + '</div>';
      } else if (e.serviceId === 'water') {
        detail = '<div class="breakdown"><div class="muted-sm">' +
          'Показание: ' + U.formatNumber(U.toNumber(e.readings && e.readings.total), 3) + ' м³ − ' +
          U.formatNumber(U.toNumber(e.previousReadings && e.previousReadings.total), 3) + ' м³ = ' +
          U.formatNumber(e.consumption, 3) + ' м³ × ' + U.formatNumber(e.rate, 2) + ' ₽/м³' +
          (e.rateKey ? ' (' + U.escapeHtml(Data.WATER_TARIFFS[e.rateKey].label) + ')' : '') + '</div></div>';
      } else if (meta.kind === 'area') {
        detail = '<div class="breakdown"><div class="muted-sm">' + U.formatNumber(obj.area, 2) + ' м² × ' + U.formatNumber(e.rate, 2) + ' ₽/м² = ' + U.formatMoney(e.amount) + '</div></div>';
      } else if (meta.kind === 'fixed') {
        detail = '<div class="breakdown"><div class="muted-sm">Абонентская плата ' + U.formatMoney(e.rate) + '/мес.</div></div>';
      }

      if (e.sections && e.sections.length) {
        detail += '<div class="breakdown"><b>Распределение по зонам дома:</b> ' + e.sections.map(function (s) {
          return U.escapeHtml(s.name) + ' — ' + U.formatMoney(s.amount);
        }).join(' · ') + '</div>';
      }

      return '<tr class="journal-row" data-entry-row="' + e.id + '">' +
        '<td>' + U.escapeHtml(U.periodLabel(e.period)) + '<div class="muted-sm">' + U.formatDateDot(e.date) + '</div></td>' +
        '<td>№' + obj.index + ' ' + U.escapeHtml(obj.label) + '<div class="muted-sm">' + U.escapeHtml(obj.address.full) + '</div></td>' +
        '<td>' + meta.icon + ' ' + U.escapeHtml(meta.label) + '</td>' +
        '<td class="num"><b>' + U.formatMoney(e.amount) + '</b>' +
          (e.amountSource === 'manual' ? '<div class="muted-sm">вручную</div>' : '') +
          (coverage && coverage.covered > 0 ? '<div class="muted-sm pos">авансом ' + U.formatMoney(coverage.covered) + '</div>' : '') +
          (coverage && coverage.uncovered > 0 && e.amount > 0 ? '<div class="muted-sm neg">к оплате ' + U.formatMoney(coverage.uncovered) + '</div>' : '') +
        '</td>' +
        '<td class="muted-sm">' + U.escapeHtml(e.note || '—') + '</td>' +
        '<td class="col-actions">' +
          '<button class="btn btn--icon" title="Детализация" data-action="toggle-breakdown" data-entry="' + e.id + '">🔍</button>' +
          '<button class="btn btn--icon" title="Изменить" data-action="edit-entry" data-entry="' + e.id + '">✏️</button>' +
          '<button class="btn btn--icon" title="Повторить в текущем месяце" data-action="repeat-entry" data-entry="' + e.id + '">⧉</button>' +
          '<button class="btn btn--icon btn--danger" title="Удалить" data-action="delete-entry" data-entry="' + e.id + '">✕</button>' +
        '</td>' +
        '</tr>' +
        '<tr class="journal-detail" data-entry-detail="' + e.id + '" hidden><td colspan="6">' + detail + '</td></tr>';
    }).join('');

    var serviceTotalsHtml = S.filter(function (s) { return totalsByService[s.id]; }).map(function (s) {
      return '<span class="pill pill--chip"><i class="dot" style="background:' + s.color + '"></i>' + U.escapeHtml(s.label) + ': ' + U.formatMoney(totalsByService[s.id]) + '</span>';
    }).join('');

    return '' +
      '<section class="section-head">' +
        '<div><h2>🧾 Журнал начислений</h2>' +
        '<p class="muted-sm">Записей: <b>' + list.length + '</b> · сумма: <b>' + U.formatMoney(totalAmount) + '</b></p>' +
        '<div class="chip-row">' + serviceTotalsHtml + '</div></div>' +
        '<div class="section-head__actions">' +
          '<button class="btn btn--primary" data-action="tab" data-view="entry">➕ Новое начисление</button>' +
          '<button class="btn btn--ghost" data-action="export-csv">⬇️ CSV</button>' +
        '</div>' +
      '</section>' +
      filtersHtml +
      (list.length ? '<div class="table-wrap"><table class="table table--journal">' +
        '<thead><tr><th>Период</th><th>Объект</th><th>Услуга</th><th class="num">Начислено</th><th>Комментарий</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">Ничего не найдено. Измените фильтры или добавьте начисления.</div>');
  }

  /* ====================================================== АРХИВ ВОДОМЕРА == */
  /**
   * Исторический архив водомера: показания, фактический расход и начисление
   * по тарифу, действовавшему в каждом периоде (селектор периодов).
   */
  function archiveView(objId) {
    var effective = State.effectiveObjects();
    var objects = objId ? effective.filter(function (o) { return o.id === objId; }) : effective;
    var schedule = State.waterSchedule(Data.OBJECTS[0].id);

    var cards = objects.map(function (obj) {
      var info = Analytics.waterArchiveSummary(obj.id);
      var stats = info.stats;
      /* Пометка «архив восстановлен» — данные-слой хранит происхождение архива */
      var copy = Data.OBJECTS.filter(function (o) { return o.id === obj.id; })[0] || {};
      var meta = (copy.services && copy.services.water && copy.services.water.archiveMeta) || null;

      if (!info.hasArchive) {
        return '<article class="card" id="archive-' + obj.id + '">' +
          '<header class="card__head"><h3>' + objectBadge(obj) + ' ' + U.escapeHtml(obj.address.full) + '</h3>' +
          (info.account ? pill('Л/С Вода Крыма № ' + info.account, 'ok') : pill('Л/С воды: ' + (info.accountNote || 'уточняется'), 'neutral')) + '</header>' +
          '<div class="empty empty--sm">Исторический архив водомера по этому объекту не передан. ' +
          'Внесите показания через калькулятор — система начнёт рассчитывать средний расход по журналу.</div>' +
          '<footer class="card__foot">' +
            '<button class="btn btn--primary btn--sm" data-action="quick-entry" data-object="' + obj.id + '">💧 Внести показания воды</button>' +
            '<button class="btn btn--ghost btn--sm" data-action="edit-meter" data-object="' + obj.id + '" data-service="water">⚙️ Заполнить ПУ воды</button>' +
          '</footer>' +
          '</article>';
      }

      var rows = stats.records.slice().reverse().map(function (rec, i, arr) {
        var prev = arr[i + 1];
        var resolved = Engine.resolveWaterRateKey(obj, rec.period, schedule);
        var bill = Engine.waterBill(rec.consumption, resolved.rateKey);
        var inJournal = info.importedPeriods.indexOf(rec.period) !== -1;
        var warning = prev && rec.reading < prev.reading;
        return '<tr class="' + (warning ? 'row-bad' : '') + '">' +
          '<td><b>' + U.escapeHtml(U.periodLabel(rec.period)) + '</b></td>' +
          '<td class="num">' + U.formatNumber(rec.reading, 2) + '</td>' +
          '<td class="num">' + (prev ? U.formatNumber(prev.reading, 2) : '—') + '</td>' +
          '<td class="num"><b>' + U.formatNumber(rec.consumption, 2) + '</b></td>' +
          '<td class="num">' + U.formatNumber(resolved.rate, 2) + '</td>' +
          '<td class="num">' + U.formatMoney(bill.total) + '</td>' +
          '<td>' + (inJournal ? pill('в журнале', 'ok') : pill('не внесено', 'warn')) + '</td>' +
          '<td>' + (rec.note ? '<span class="muted-sm">' + U.escapeHtml(rec.note) + '</span>' : '') +
            (warning ? '<span class="neg">показание меньше предыдущего</span>' : '') + '</td>' +
        '</tr>';
      }).join('');

      var missing = stats.months - 1; /* без стартовой записи */
      var rateNote = info.forecast && info.forecast.detail && info.forecast.detail.formula
        ? info.forecast.detail.formula : '—';

      return '<article class="card" id="archive-' + obj.id + '">' +
        '<header class="card__head">' +
          '<div><h3>' + objectBadge(obj) + ' ' + U.escapeHtml(obj.address.full) + '</h3>' +
          '<div class="muted-sm">' + (info.account ? 'Л/С Вода Крыма № ' + U.escapeHtml(info.account) : 'Л/С воды: ' + U.escapeHtml(info.accountNote || 'уточняется')) +
          ' · тариф в текущем периоде: ' + U.formatNumber(info.tariff.rate, 2) + ' ₽/м³ (' + U.escapeHtml(info.tariff.label) + ')</div></div>' +
          '<div class="card__head-right">' + pill(stats.count + ' ' + U.plural(stats.count, 'запись', 'записи', 'записей'), 'ok') + '</div>' +
        '</header>' +

        '<div class="kpi-grid kpi-grid--small">' +
          '<div class="kpi"><div class="kpi__label">Показание сегодня</div><div class="kpi__value">' + U.formatNumber(stats.lastReading, 2) + ' <small>м³</small></div>' +
            '<span class="kpi__delta">' + U.escapeHtml(U.periodLabel(stats.lastPeriod)) + '</span></div>' +
          '<div class="kpi"><div class="kpi__label">Средний расход (3 мес.)</div><div class="kpi__value">' + U.formatNumber(stats.average, 2) + ' <small>м³</small></div>' +
            '<span class="kpi__delta">' + U.formatMoney(info.costEstimate) + '/мес по текущему тарифу</span></div>' +
          '<div class="kpi"><div class="kpi__label">Средний за всю историю</div><div class="kpi__value">' + U.formatNumber(stats.averageAll, 2) + ' <small>м³</small></div>' +
            '<span class="kpi__delta">' + stats.months + ' мес. наблюдений</span></div>' +
          '<div class="kpi kpi--ok"><div class="kpi__label">Израсходовано всего</div><div class="kpi__value">' + U.formatNumber(stats.totalConsumption, 0) + ' <small>м³</small></div>' +
            '<span class="kpi__delta">≈ ' + U.formatMoney(info.totalCost) + ' по текущему тарифу</span></div>' +
        '</div>' +

        (meta && meta.source === 'reconstructed'
          ? '<div class="notice notice--warn"><b>Архив восстановлен.</b> ' +
            U.escapeHtml(meta.note || 'Значения требуют сверки с квитанциями.') +
            ' Контрольные точки (стартовое и последнее показание, средние расходы, месяцы без расхода) совпадают с исходными, ' +
            'промежуточные месяцы восстановлены правдоподобно. Пришлите исходные показания — заменю в data-слое ' +
            '<code>assets/js/data/config.js</code>.</div>'
          : '') +

        '<div class="chip-row">' +
          '<button class="btn btn--primary btn--sm" data-action="import-archive" data-object="' + obj.id + '">⬇️ Перенести архив в журнал</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="import-archive" data-object="' + obj.id + '" data-zero="1">⬇️ …включая месяцы без расхода</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="import-archive" data-object="' + obj.id + '" data-overwrite="1">🔄 Пересчитать перенесённые месяцы</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="export-archive" data-object="' + obj.id + '">⬆️ CSV архива</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="open-archive" data-object="' + obj.id + '">🔄 Обновить</button>' +
        '</div>' +

        '<div class="forecast forecast--ok">📈 ' + U.escapeHtml(rateNote) +
          '. В журнал перенесено ' + info.importedPeriods.length + ' из ' + stats.count + ' ' + U.plural(stats.count, 'записи', 'записей', 'записей') + '.</div>' +

        '<details class="details" open><summary>История показаний (' + stats.count + ')</summary>' +
        '<div class="table-wrap"><table class="table table--mini">' +
          '<thead><tr><th>Период</th><th class="num">Показание, м³</th><th class="num">Предыдущее</th><th class="num">Расход, м³</th>' +
          '<th class="num">Тариф, ₽/м³</th><th class="num">Начислено</th><th>Статус</th><th>Примечание</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
          '<tfoot><tr><td colspan="3"><b>Итого расход</b></td><td class="num"><b>' + U.formatNumber(stats.totalConsumption, 2) + '</b></td>' +
          '<td colspan="3" class="num"><b>' + U.formatMoney(info.totalCost) + '</b> по текущему тарифу</td><td></td></tr></tfoot>' +
        '</table></div>' +
        '<div class="muted-sm">Периоды без переданных показаний (например, март или ноябрь 2024) в архиве отсутствуют — ' +
        'расход рассчитан между фактическими снятиями. Расход «0» означает, что показание не изменилось (квартира простаивала).</div>' +
        '</details>' +
        '</article>';
    }).join('');

    return '' +
      '<section class="section-head">' +
        '<div><h2>💧 Исторический архив водомеров</h2>' +
        '<p class="muted-sm">Показания из архива используются для расчёта среднего расхода воды, если в журнале ещё мало данных, ' +
        'и могут быть перенесены в журнал начислений. Сумма каждого месяца считается по тарифу, действовавшему в этом месяце ' +
        '(селектор периодов). Объекты № 1 и № 6: лицевые счета водоснабжения уточняются.</p></div>' +
        '<div class="section-head__actions">' +
          (objId ? '<button class="btn btn--ghost btn--sm" data-action="open-archive" data-object="">Показать все объекты</button>' : '') +
          '<button class="btn btn--ghost btn--sm" data-action="tab" data-view="tariffs">График тарифов →</button>' +
        '</div>' +
      '</section>' +
      cards;
  }

  /* ============================================================ ПОВЕРКИ == */
  function verificationView(nowISO) {
    var rows = Analytics.verificationIndex(nowISO);
    var expired = rows.filter(function (r) { return r.css === 'expired'; });
    var warning = rows.filter(function (r) { return r.css === 'warning'; });

    var body = rows.map(function (r) {
      return '<tr class="' + (r.css === 'expired' ? 'row-bad' : (r.css === 'warning' ? 'row-warn' : '')) + '">' +
        '<td><b>№' + r.objectIndex + '</b> ' + U.escapeHtml(r.objectLabel) + '<div class="muted-sm">' + U.escapeHtml(r.address) + '</div></td>' +
        '<td>' + r.icon + ' ' + U.escapeHtml(r.serviceLabel) + '</td>' +
        '<td>' + U.escapeHtml(r.serial || '—') + '<div class="muted-sm">' + U.escapeHtml(r.model || '') + '</div></td>' +
        '<td>' + (r.lastCheckDate ? U.formatDateDot(r.lastCheckDate) : '—') + '</td>' +
        '<td>' + (r.periodYears ? r.periodYears + ' лет' : '—') + '</td>' +
        '<td><b>' + (r.nextCheckDate ? U.formatDateDot(r.nextCheckDate) : '—') + '</b></td>' +
        '<td class="num">' + (r.daysLeft === null ? '—' : U.formatNumber(r.daysLeft, 0) + ' дн.') + '</td>' +
        '<td>' + verificationPill(r) + '<div class="muted-sm">' + U.escapeHtml(r.text) + '</div></td>' +
        '<td>' + (r.hasData ? progressBar(r.progressPercent, r.css) : '') + '</td>' +
        '<td><button class="btn btn--ghost btn--sm" data-action="edit-meter" data-object="' + r.objectId + '" data-service="' + r.serviceId + '">⚙️ Изменить</button></td>' +
        '</tr>';
    }).join('');

    return '' +
      '<section class="section-head">' +
        '<div><h2>⏱️ Мониторинг госповерки приборов учёта</h2>' +
        '<p class="muted-sm">Дата следующей поверки = дата последней поверки + межповерочный интервал. Статусы: ' +
        '<span class="vstatus vstatus--bad">❌ ПОВЕРКА ИСТЕКЛА</span> ' +
        '<span class="vstatus vstatus--warn">⚠️ ТРЕБУЕТСЯ ПОВЕРКА</span> ' +
        '<span class="vstatus vstatus--ok">✅ Поверка ОК</span> ' +
        '(порог предупреждения — ' + Data.RULES.verificationWarnDays + ' дней).</p></div>' +
        '<div class="section-head__actions">' +
          '<span class="pill ' + (expired.length ? 'pill--bad' : 'pill--ok') + '">Просрочено: ' + expired.length + '</span>' +
          '<span class="pill ' + (warning.length ? 'pill--warn' : 'pill--neutral') + '">Скоро поверка: ' + warning.length + '</span>' +
        '</div>' +
      '</section>' +
      '<div class="filters filters--tight">' +
        '<div class="field"><label>Проверить статусы на дату</label>' +
          '<input type="date" name="verificationDate" data-filter="verificationDate" value="' + U.escapeHtml(nowISO) + '"></div>' +
        '<div class="field"><label>&nbsp;</label>' +
          '<button class="btn btn--ghost" data-action="verification-today">↺ Сегодня, ' + U.escapeHtml(U.formatDateDot(U.todayISO())) + '</button></div>' +
        '<div class="field field--grow"><label>&nbsp;</label>' +
          '<div class="muted-sm">Можно заглянуть в будущее: укажите дату — и увидите, какие счётчики окажутся просроченными. ' +
          'Расчёт всегда идёт от даты последней поверки плюс межповерочный интервал.</div></div>' +
      '</div>' +
      '<div class="table-wrap"><table class="table table--verification">' +
        '<thead><tr><th>Объект</th><th>Услуга</th><th>Прибор учёта</th><th>Последняя поверка</th><th>Интервал</th><th>Следующая поверка</th><th class="num">Осталось</th><th>Статус</th><th>Износ срока</th><th></th></tr></thead>' +
        '<tbody>' + body + '</tbody>' +
      '</table></div>';
  }

  /* ============================================================== ТАРИФЫ = */
  function gridTable(categoryId, zoneIds) {
    return zoneIds.map(function (zoneId) {
      var rows = Engine.describeElectricityGrid(categoryId, zoneId);
      if (!rows) return '';
      var scale = Data.ELECTRICITY_TARIFFS[categoryId].scales[zoneId];
      return '<div class="grid-block"><h4>' + U.escapeHtml(scale.label) + ' <span class="muted-sm">' + U.escapeHtml(scale.hours || '') + '</span></h4>' +
        '<table class="table table--mini"><thead><tr><th>Ступень</th><th>Диапазон</th><th class="num">Ставка, ₽/кВтч</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + U.escapeHtml(r.title) + '</td><td>' + U.escapeHtml(r.rangeLabel) + '</td><td class="num"><b>' + U.formatNumber(r.rate, 2) + '</b></td></tr>';
        }).join('') + '</tbody></table></div>';
    }).join('');
  }

  /** Селектор периодов: какая ставка воды действует с какого месяца */
  function waterSchedulePanel() {
    var globalSchedule = State.waterSchedule(Data.OBJECTS[0].id);
    var segments = Analytics.waterScheduleSegments(Data.OBJECTS[0].id);
    var current = State.activePeriod();

    var segmentRows = segments.map(function (seg) {
      var range = seg.toPeriod
        ? U.periodLabel(seg.fromPeriod) + ' — ' + U.periodLabel(seg.toPeriod)
        : 'с ' + U.periodLabel(seg.fromPeriod) + ' → бессрочно';
      return '<tr class="' + (seg.isActive ? 'row-ok' : '') + '">' +
        '<td><b>' + U.escapeHtml(range) + '</b>' + (seg.isActive ? ' ' + pill('действует сейчас · ' + U.periodLabelShort(current), 'ok') : '') +
          (seg.note ? '<div class="muted-sm">' + U.escapeHtml(seg.note) + '</div>' : '') + '</td>' +
        '<td>' + U.escapeHtml(seg.label) + '</td>' +
        '<td class="num"><b>' + U.formatNumber(seg.rate, 2) + ' ₽/м³</b></td>' +
        '<td><button class="btn btn--icon btn--danger" data-action="water-schedule-remove" data-period="' + seg.fromPeriod + '" title="Удалить строку графика">✕</button></td>' +
      '</tr>';
    }).join('');

    var tariffOptions = Data.WATER_TARIFF_ORDER.map(function (k) {
      var t = Data.WATER_TARIFFS[k];
      return '<option value="' + k + '">' + U.escapeHtml(t.label) + ' — ' + U.formatNumber(t.rate, 2) + ' ₽/м³</option>';
    }).join('');

    /* Стоимость одного и того же расхода (11 м³) по каждому тарифу — наглядно */
    var sampleVolume = 11;
    var compareRows = Data.WATER_TARIFF_ORDER.map(function (k) {
      var t = Data.WATER_TARIFFS[k];
      return '<tr><td>' + U.escapeHtml(t.label) + (k === Data.WATER_DEFAULT_RATE_KEY ? ' ' + pill('по умолчанию', 'ok') : '') +
        '<div class="muted-sm">' + U.escapeHtml(t.note) + '</div></td>' +
        '<td class="num">' + U.formatNumber(t.rate, 2) + ' ₽/м³</td>' +
        '<td class="num">' + U.formatMoney(sampleVolume * t.rate) + '</td></tr>';
    }).join('');

    return '<article class="card">' +
      '<header class="card__head"><h3>🗓️ Селектор периодов: какой тариф воды применяется</h3>' +
        '<span class="muted-sm">График задаёт ставку начиная с месяца; действует до следующей строки</span></header>' +

      '<form data-form="water-schedule" class="inline-form">' +
        '<div class="field field--date"><label>Действует с периода</label>' +
          '<input type="month" name="fromPeriod" value="' + U.escapeHtml(current) + '" required></div>' +
        '<div class="field"><label>Тариф</label>' +
          '<select name="rateKey">' + tariffOptions + '</select></div>' +
        '<div class="field field--grow"><label>Комментарий</label>' +
          '<input type="text" name="note" placeholder="например: индексация с января 2027"></div>' +
        '<button class="btn btn--primary" type="submit">➕ Добавить период</button>' +
      '</form>' +

      '<div class="table-wrap"><table class="table"><thead><tr><th>Период действия</th><th>Тариф</th><th class="num">Ставка</th><th></th></tr></thead>' +
      '<tbody>' + segmentRows + '</tbody></table></div>' +

      '<div class="btn-row" style="margin-top:.5rem">' +
        '<button class="btn btn--ghost btn--sm" data-action="water-schedule-apply-all">Применить график ко всем объектам</button>' +
        '<button class="btn btn--ghost btn--sm" data-action="water-schedule-reset">Сбросить к базовому (актуальный 47,96 ₽)</button>' +
      '</div>' +
      '<div class="muted-sm">График применяется к расчёту воды за месяц: при внесении показаний за прошлый период система возьмёт ставку, действовавшую в том месяце.</div>' +

      '<h4 style="margin-top:1rem">Сравнение тарифов при расходе ' + sampleVolume + ' м³/мес</h4>' +
      '<div class="table-wrap"><table class="table table--mini"><thead><tr><th>Тариф</th><th class="num">Ставка</th><th class="num">Начисление за ' + sampleVolume + ' м³</th></tr></thead>' +
      '<tbody>' + compareRows + '</tbody></table></div>' +
      '</article>';
  }

  function tariffsView() {
    var examples = [
      { label: 'Объект №1 (Л/С 173701)', obj: 'obj-01' },
      { label: 'Объект №3 (Л/С 103573, День/Ночь)', obj: 'obj-03' },
      { label: 'Объект №5 (Л/С 104987, 1 зона)', obj: 'obj-05' },
      { label: 'Объект №6 (Л/С 010588, село)', obj: 'obj-06' }
    ].map(function (x) {
      var eff = State.effectiveObject(x.obj);
      var zoneIds = Engine.scalesForObject(eff);
      return '<div class="tgrid">' +
        '<header><h4>' + U.escapeHtml(x.label) + '</h4><span class="pill pill--chip">' + U.escapeHtml(Data.ELECTRICITY_TARIFFS[eff.services.electricity.category].label) + '</span></header>' +
        gridTable(eff.services.electricity.category, zoneIds) +
        '<div class="muted-sm">ПУ № ' + U.escapeHtml(eff.services.electricity.meter.serial) + ' · ' + U.escapeHtml(eff.services.electricity.meter.model) + '</div>' +
        '</div>';
    }).join('');

    var waterRows = Data.WATER_TARIFF_ORDER.map(function (key) {
      var t = Data.WATER_TARIFFS[key];
      return '<tr><td><b>' + U.escapeHtml(t.label) + '</b>' + (t.badge ? ' ' + pill(t.badge, key === Data.WATER_DEFAULT_RATE_KEY ? 'ok' : 'neutral') : '') +
        '<div class="muted-sm">' + U.escapeHtml(t.note) + '</div></td>' +
        '<td class="num"><b>' + U.formatNumber(t.rate, 2) + ' ₽/м³</b></td>' +
        '<td>' + (key === Data.WATER_DEFAULT_RATE_KEY ? 'применяется по умолчанию' : 'переключаемый вариант') + '</td>' +
        '<td><button class="btn btn--ghost btn--sm" data-action="set-water-default" data-rate-key="' + key + '">Сделать основным</button></td></tr>';
    }).join('');

    var serviceRows = S.map(function (s) {
      return '<tr><td>' + s.icon + ' <b>' + U.escapeHtml(s.label) + '</b></td>' +
        '<td>' + U.escapeHtml(s.hint) + '</td>' +
        '<td>' + U.escapeHtml(s.kind === 'area' ? 'площадь × тариф' : (s.kind === 'meter' ? 'расход × тариф' : 'фиксированная плата')) + '</td>' +
        '<td>' + U.escapeHtml(s.unit) + '</td></tr>';
    }).join('');

    return '' +
      '<section class="section-head"><div><h2>📚 Тарифные сетки и правила расчёта</h2>' +
      '<p class="muted-sm">Все ставки задаются в <code>assets/js/data/config.js</code>. Электроэнергия считается по кумулятивным ступеням: расход = текущие показания − предыдущие.</p></div></section>' +

      '<article class="card">' +
        '<header class="card__head"><h3>⚡ Электроэнергия: примеры сеток по объектам</h3>' +
        '<span class="muted-sm">Раздельные лимиты для зон День и Ночь</span></header>' +
        '<div class="tgrid-grid">' + examples + '</div>' +
      '</article>' +

      waterSchedulePanel() +

      '<article class="card">' +
        '<header class="card__head"><h3>💧 Водоснабжение — ГУП РК «Вода Крыма»</h3>' +
        '<span class="muted-sm">Начисление = (текущее показание − предыдущее) × тариф</span></header>' +
        '<div class="table-wrap"><table class="table"><thead><tr><th>Вариант тарифа</th><th class="num">Ставка</th><th>Статус</th><th></th></tr></thead><tbody>' +
        waterRows + '</tbody></table></div>' +
        '<h4 style="margin-top:1rem">Лицевые счета водоснабжения по объектам</h4>' +
        '<div class="table-wrap"><table class="table table--mini"><thead><tr>' +
          '<th>Объект</th><th>Л/С Вода Крыма</th><th>Тариф в текущем периоде</th><th class="num">Архив водомера</th><th class="num">Средний расход</th><th></th>' +
        '</tr></thead><tbody>' +
        State.effectiveObjects().map(function (o) {
          var info = Analytics.waterArchiveSummary(o.id);
          var next = Analytics.waterTariffFor(o.id, U.addMonths(State.activePeriod(), 1));
          var changed = next.rateKey !== info.tariff.rateKey;
          return '<tr>' +
            '<td>№' + o.index + ' <b>' + U.escapeHtml(o.label) + '</b></td>' +
            '<td>' + (info.account ? U.escapeHtml(info.account) : '<span class="muted-sm">' + U.escapeHtml(info.accountNote || 'уточняется') + '</span>') + '</td>' +
            '<td>' + U.formatNumber(info.tariff.rate, 2) + ' ₽/м³ <span class="muted-sm">(' + U.escapeHtml(info.tariff.label) + ')</span>' +
              (changed ? '<div class="muted-sm">со следующего периода: ' + U.formatNumber(next.rate, 2) + ' ₽/м³</div>' : '') + '</td>' +
            '<td class="num">' + (info.hasArchive ? info.months + ' ' + U.plural(info.months, 'запись', 'записи', 'записей') : '—') + '</td>' +
            '<td class="num">' + (info.hasArchive ? U.formatNumber(info.average, 2) + ' м³/мес' : '—') + '</td>' +
            '<td>' + (info.hasArchive
              ? '<button class="btn btn--ghost btn--sm" data-action="open-archive" data-object="' + o.id + '">Архив →</button>'
              : '<span class="muted-sm">нет данных</span>') + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>' +
      '</article>' +

      '<article class="card">' +
        '<header class="card__head"><h3>🧮 Как считает система</h3></header>' +
        '<div class="table-wrap"><table class="table"><thead><tr><th>Услуга</th><th>Логика расчёта</th><th>Тип</th><th>Ед. объёма</th></tr></thead><tbody>' +
        serviceRows + '</tbody></table></div>' +
      '</article>';
  }

  /* =========================================================== ДАННЫЕ ==== */
  function dataView(state) {
    var s = State.get();
    var payload = State.exportPayload();
    var size = new Blob([JSON.stringify(payload)]).size;
    var withOverrides = Data.OBJECTS.filter(function (o) { return State.hasOverrides(o.id); }).length;

    var SyncUI = global.ZHKX.SyncUI;

    return '' +
      '<section class="section-head"><div><h2>💾 Данные, резервные копии и импорт</h2>' +
      '<p class="muted-sm">Данные хранятся на сервере в <code>data/state.js</code> (ревизии — в <code>data/history/</code>), ' +
      'а в браузере — локальная копия в localStorage (' + (State.isStorageAvailable() ? 'доступно' : '<b>недоступно — работаем в памяти</b>') +
      ') для офлайн-работы. Резервный JSON-бэкап всё равно полезен: его можно забрать с собой.</p></div></section>' +

      (SyncUI ? SyncUI.dataCard() : '') +

      '<section class="grid grid--2">' +
        '<article class="card">' +
          '<header class="card__head"><h3>⬇️ Экспорт бэкапа</h3></header>' +
          '<div class="stats">' +
            '<div class="kv"><span>Объектов в реестре</span><b>' + Data.OBJECTS.length + '</b></div>' +
            '<div class="kv"><span>Записей журнала</span><b>' + s.journal.length + '</b></div>' +
            '<div class="kv"><span>Движений кошелька</span><b>' + s.movements.length + '</b></div>' +
            '<div class="kv"><span>Пользовательских правок</span><b>' + withOverrides + '</b></div>' +
            '<div class="kv"><span>Размер бэкапа</span><b>' + U.formatNumber(size / 1024, 1) + ' КБ</b></div>' +
            '<div class="kv"><span>Обновлено</span><b>' + U.formatDateISO(String(s.meta.updatedAt).slice(0, 10)) + '</b></div>' +
          '</div>' +
          '<footer class="card__foot">' +
            '<button class="btn btn--primary" data-action="export-json">⬇️ Скачать JSON-бэкап</button>' +
            '<button class="btn btn--ghost" data-action="export-csv">📄 Экспорт журнала в CSV</button>' +
          '</footer>' +
        '</article>' +

        '<article class="card">' +
          '<header class="card__head"><h3>⬆️ Импорт бэкапа</h3></header>' +
          '<form data-form="import" class="form-stack">' +
            '<div class="field"><label>Файл резервной копии (.json)</label>' +
              '<input type="file" name="file" accept="application/json,.json"></div>' +
            '<div class="field"><label>Режим импорта</label>' +
              '<select name="mode">' +
                '<option value="replace">Заменить текущие данные (полное восстановление)</option>' +
                '<option value="merge">Добавить недостающие месяцы (слияние)</option>' +
              '</select></div>' +
            '<button class="btn btn--primary" type="submit">⬆️ Загрузить и восстановить</button>' +
          '</form>' +
          '<div class="muted-sm">Слияние добавляет только те периоды, которых ещё нет в журнале: удобно для переноса данных с другого устройства.</div>' +
        '</article>' +
      '</section>' +

      '<section class="card">' +
        '<header class="card__head"><h3>🧪 Демонстрационные данные и сброс</h3></header>' +
        '<div class="danger-zone">' +
          '<div class="dz"><b>Заполнить демо-историей</b><span class="muted-sm">12 месяцев начислений по всем 6 объектам, показания счётчиков и крупные авансы (в т.ч. 5 000 ₽ на капремонт кв. 102 — пример из ТЗ).</span>' +
            '<button class="btn btn--ghost" data-action="seed-demo">Наполнить демо-данными</button></div>' +
          '<div class="dz dz--danger"><b>Полный сброс</b><span class="muted-sm">Удаляет журнал, движения кошельков, показания и правки тарифов. Данные реестра объектов (data-слой) не пострадают.</span>' +
            '<button class="btn btn--danger" data-action="reset-data">Очистить всё</button></div>' +
        '</div>' +
      '</section>';
  }

  var Views = {
    pill: pill,
    money: money,
    progressBar: progressBar,
    objectBadge: objectBadge,
    accountLine: accountLine,
    verificationPill: verificationPill,
    kpiCards: kpiCards,
    alertsPanel: alertsPanel,
    dashboardView: dashboardView,
    objectsView: objectsView,
    walletView: walletView,
    walletCard: walletCard,
    journalView: journalView,
    verificationView: verificationView,
    archiveView: archiveView,
    tariffsView: tariffsView,
    dataView: dataView,
    objectCard: objectCard,
    movementsTable: movementsTable
  };

  var ns = global.ZHKX = global.ZHKX || {};
  ns.Views = Views;
})(typeof window !== 'undefined' ? window : globalThis);
