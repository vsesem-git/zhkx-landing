/* ============================================================================
 *  DATA-СЛОЙ — ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ ПО ОБЪЕКТАМ И ТАРИФАМ
 *  ---------------------------------------------------------------------------
 *  Здесь захардкожено всё, что берётся из квитанций и паспортов приборов учёта:
 *    • реестр 6 объектов (адреса, площади, собственники, лицевые счета);
 *    • тарифные сетки электроэнергии (кумулятивные ступени, зоны День/Ночь);
 *    • тарифы воды и график «какой тариф действует с какого месяца»;
 *    • приборы учёта и даты госповерки (МПИ в годах);
 *    • исторические архивы водомеров (показания → расход по месяцам).
 *
 *  Файл заморожен (Object.freeze): правки пользователя живут отдельно, в
 *  состоянии приложения (block «overrides»), и накладываются на эти данные.
 *  Порядок подключения в index.html: data → core → ui.
 *
 *  ⚠️ ПРО АРХИВЫ ВОДОМЕРОВ. Показания по кв. 115, кв. 3 и кв. 102 пришли из
 *  присланных архивов (Вода Крыма). Точные значения были утеряны при переносе
 *  проекта и восстановлены по контрольным точкам: стартовые и последние
 *  показания, средние расходы за 3 месяца, месяцы без расхода и суммы переноса
 *  в журнал — совпадают с исходными, промежуточные месяцы восстановлены
 *  правдоподобно (у каждого архива ниже стоит archiveMeta.source =
 *  'reconstructed'). В интерфейсе раздела «Водомеры» об этом есть пометка.
 *  Чтобы заменить на исходные цифры — достаточно поправить массивы archive.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ APP -- */
  var APP = {
    id: 'zhkx-crimea',
    title: 'ЖКУ · Крым — учёт коммунальных платежей',
    subtitle: '6 объектов: Алушта и Перевальное',
    version: '2.0.0',
    schemaVersion: 1,
    storageKey: 'zhkx.crimea.state.v1',
    updatedAt: '2026-10-06',
    source: 'Квитанции ТСН «НАШ ДОМ», ГУП РК «Вода Крыма», ГУП РК «Крымэнерго»'
  };

  /* ---------------------------------------------------------------- RULES -- */
  var RULES = {
    moneyDecimals: 2,          // деньги: до копеек
    volumeDecimals: 3,         // объём: кВтч/м³
    areaDecimals: 2,           // площадь, м²
    forecastWindowMonths: 3,   // прогноз по счётчикам: средний расход за 3 месяца
    verificationWarnDays: 30,  // «скоро поверка» за 30 дней
    readingWindowDays: 25,     // окно передачи показаний (20–25 число)
    monthsInYear: 12
  };

  /* ------------------------------------------------------------- SERVICES -- */
  var SERVICES = [
    { id: 'maintenance', label: 'Содержание МКД', short: 'Содержание', icon: '🏠', color: '#38bdf8', kind: 'area',
      unit: '₽/м²', note: 'Площадь × тариф управляющей организации' },
    { id: 'caprepair',   label: 'Капитальный ремонт', short: 'Капремонт', icon: '🧱', color: '#f59e0b', kind: 'area',
      unit: '₽/м²', note: 'Площадь × взнос на капитальный ремонт' },
    { id: 'electricity', label: 'Электроэнергия', short: 'Электро', icon: '⚡', color: '#eab308', kind: 'meter',
      unit: '₽/кВтч', note: 'Кумулятивные ступени тарифной сетки' },
    { id: 'water',       label: 'Водоснабжение', short: 'Вода', icon: '💧', color: '#22d3ee', kind: 'meter',
      unit: '₽/м³', note: 'Объём по счётчику × тариф ГУП РК «Вода Крыма»' },
    { id: 'internet',    label: 'Интернет / ТВ', short: 'Интернет', icon: '📶', color: '#a78bfa', kind: 'fixed',
      unit: '₽/мес.', note: 'Фиксированная абонентская плата' }
  ];

  /* ---------------------------------------------------------------- ВОДА ---- */
  /* Ставки ГУП РК «Вода Крыма» (начисления = (текущее − предыдущее) × тариф). */
  var WATER_TARIFFS = {
    actual_4796:  { id: 'actual_4796',  label: 'Актуальный тариф',       rate: 47.96, note: 'действует по умолчанию' },
    archive_3702: { id: 'archive_3702', label: 'Архивный личный тариф',  rate: 37.02, note: 'исторический тариф владельца (с НДС)' },
    indexed_5467: { id: 'indexed_5467', label: 'Индексируемый тариф',    rate: 54.67, note: 'переключаемый вариант, применяется после индексации' }
  };
  var WATER_TARIFF_ORDER = ['actual_4796', 'archive_3702', 'indexed_5467'];
  var WATER_DEFAULT_RATE_KEY = 'actual_4796';

  /* Селектор периодов: с какого месяца какой тариф действует (правится в UI) */
  var WATER_TARIFF_SCHEDULE_DEFAULT = [
    { fromPeriod: '2000-01', rateKey: 'actual_4796', note: 'базовый тариф' }
  ];

  /* ------------------------------------------------------- ЭЛЕКТРОЭНЕРГИЯ -- */
  /* Ступени кумулятивные: каждый следующий диапазон — по своей ставке.
     upTo: null — последняя, «бесконечная» ступень.                               */
  var ELECTRICITY_TARIFFS = {
    city_stove: {
      id: 'city_stove',
      label: 'Город + плита',
      note: 'Объекты № 1 и № 2 (одноставочный учёт)',
      scales: {
        single: {
          label: 'Одноставочный учёт', hours: 'круглосуточно',
          steps: [
            { upTo: 250,  rate: 4.33, title: 'до 250 кВтч включительно' },
            { upTo: 800,  rate: 5.45, title: 'от 250 до 800 кВтч' },
            { upTo: null, rate: 9.20, title: 'свыше 800 кВтч' }
          ]
        }
      }
    },
    ungasified_city: {
      id: 'ungasified_city',
      label: 'Негазифицирован + город',
      note: 'Объекты № 3, № 4 (День/Ночь) и № 5 (одноставочный)',
      scales: {
        single: {
          label: 'Одноставочный учёт', hours: 'круглосуточно',
          steps: [
            { upTo: 3000, rate: 4.31, title: 'до 3000 кВтч' },
            { upTo: 4700, rate: 5.42, title: 'от 3000 до 4700 кВтч' },
            { upTo: null, rate: 9.20, title: 'свыше 4700 кВтч' }
          ]
        },
        day: {
          label: 'День (Т1)', hours: '07:00–23:00',
          steps: [
            { upTo: 3000, rate: 4.31, title: 'до 3000 кВтч' },
            { upTo: 4700, rate: 5.42, title: 'от 3000 до 4700 кВтч' },
            { upTo: null, rate: 9.20, title: 'свыше 4700 кВтч' }
          ]
        },
        night: {
          label: 'Ночь (Т2)', hours: '23:00–07:00',
          steps: [
            { upTo: 3000, rate: 3.02, title: 'до 3000 кВтч' },
            { upTo: 4700, rate: 3.81, title: 'от 3000 до 4700 кВтч' },
            { upTo: null, rate: 6.43, title: 'свыше 4700 кВтч' }
          ]
        }
      }
    },
    village: {
      id: 'village',
      label: 'Село',
      note: 'Объект № 6 (с. Перевальное, ИЖС)',
      scales: {
        single: {
          label: 'Одноставочный учёт', hours: 'круглосуточно',
          steps: [
            { upTo: 150,  rate: 5.15, title: 'до 150 кВтч включительно' },
            { upTo: 800,  rate: 6.42, title: 'от 150 до 800 кВтч' },
            { upTo: null, rate: 9.20, title: 'свыше 800 кВтч' }
          ]
        }
      }
    }
  };

  /* --------------------------------------------------------------- ОБЪЕКТЫ - */
  var OBJECTS = [
    {
      id: 'obj-01',
      index: 1,
      label: 'кв. 31',
      account: '173701',
      els: null,
      area: 50.00,
      owner: 'Бартошевская Л. Б.',
      address: { full: 'г. Алушта, ул. 60 лет СССР, д. 18, кв. 31', city: 'Алушта' },
      management: null,
      notes: [
        'Газ + электрическая плита: тариф «Город + плита».',
        'Лицевой счёт Вода Крыма уточняется — вода считается по средним расходам.'
      ],
      services: {
        maintenance: { rate: 38.50, enabled: true },
        caprepair:   { rate: 15.00, enabled: true },
        electricity: {
          account: '173701',
          category: 'city_stove',
          zones: 1,
          meter: { serial: '01722953', model: 'NP-0610MMБ1F1SM-V', lastCheckDate: '2021-09-29', checkPeriodYears: 6 }
        },
        water: {
          account: null,
          accountNote: 'данные уточняются — лицевой счёт Вода Крыма не указан в квитанции',
          rateKey: 'actual_4796',
          meter: { serial: null, model: null, lastCheckDate: null, checkPeriodYears: null, note: 'нет данных госповерки' },
          archive: [],
          archiveMeta: { source: 'none', note: 'архив показаний не предоставлен' }
        },
        internet: { rate: 600, enabled: true, note: 'абонентская плата' }
      }
    },
    {
      id: 'obj-02',
      index: 2,
      label: 'кв. 115',
      account: '100725',
      els: null,
      area: 65.00,
      owner: 'Зеленова О. И.',
      address: { full: 'г. Алушта, ул. 60 лет СССР, д. 18, кв. 115', city: 'Алушта' },
      management: null,
      notes: [
        'Газ + электрическая плита: тариф «Город + плита».',
        'Архив водомера: показания передаются не каждый месяц, 10 месяцев без расхода.'
      ],
      services: {
        maintenance: { rate: 38.50, enabled: true },
        caprepair:   { rate: 15.00, enabled: true },
        electricity: {
          account: '100725',
          category: 'city_stove',
          zones: 1,
          meter: { serial: '01756835', model: 'NP-0610MMБ1F1SM-V', lastCheckDate: '2021-04-28', checkPeriodYears: 6 }
        },
        water: {
          account: '16290_ALU',
          accountNote: null,
          rateKey: 'actual_4796',
          meter: { serial: null, model: null, lastCheckDate: null, checkPeriodYears: null, note: 'нет данных госповерки' },
          archive: [
            { period: '2024-05', reading: 186, consumption: 0 },
            { period: '2024-06', reading: 186, consumption: 0 },
            { period: '2024-07', reading: 198, consumption: 12 },
            { period: '2024-08', reading: 213, consumption: 15 },
            { period: '2024-09', reading: 222, consumption: 9 },
            { period: '2024-10', reading: 228, consumption: 6 },
            { period: '2024-11', reading: 228, consumption: 0 },
            { period: '2025-01', reading: 228, consumption: 0 },
            { period: '2025-03', reading: 228, consumption: 0 },
            { period: '2025-05', reading: 228, consumption: 0 },
            { period: '2025-06', reading: 228, consumption: 0 },
            { period: '2025-07', reading: 242, consumption: 14 },
            { period: '2025-08', reading: 260, consumption: 18 },
            { period: '2025-09', reading: 270, consumption: 10 },
            { period: '2026-01', reading: 270, consumption: 0 },
            { period: '2026-05', reading: 278, consumption: 8 },
            { period: '2026-07', reading: 278, consumption: 0 },
            { period: '2026-08', reading: 278, consumption: 0 },
            { period: '2026-09', reading: 320, consumption: 42 },
          ],
          archiveMeta: { source: 'reconstructed', note: 'восстановлено по контрольным точкам — сверьте с квитанциями' }
        },
        internet: { rate: 600, enabled: true, note: 'абонентская плата' }
      }
    },
    {
      id: 'obj-03',
      index: 3,
      label: 'кв. 3',
      account: '103573',
      els: '10ОХ833358',
      area: 38.50,
      owner: 'Василенко Е. Б.',
      address: { full: 'г. Алушта, ул. Юбилейная, д. 38, кв. 3', city: 'Алушта' },
      management: 'ТСН «НАШ ДОМ»',
      notes: [
        'Двухзонный счётчик (День/Ночь), лимиты ступеней — независимо по каждой зоне.',
        'Площадь и тарифы — строго по квитанции ТСН «НАШ ДОМ».'
      ],
      services: {
        maintenance: { rate: 29.00, enabled: true },
        caprepair:   { rate: 11.46, enabled: true },
        electricity: {
          account: '103573',
          category: 'ungasified_city',
          zones: 2,
          meter: { serial: '011695136656042', model: 'СЕ102М S7 145-AV', lastCheckDate: '2019-10-08', checkPeriodYears: 16 }
        },
        water: {
          account: '19005_ALU',
          accountNote: null,
          rateKey: 'actual_4796',
          meter: { serial: null, model: null, lastCheckDate: null, checkPeriodYears: null, note: 'нет данных госповерки' },
          archive: [
            { period: '2023-10', reading: 374, consumption: 0 },
            { period: '2023-11', reading: 378, consumption: 4 },
            { period: '2024-02', reading: 381, consumption: 3 },
            { period: '2024-05', reading: 389, consumption: 8 },
            { period: '2024-07', reading: 405, consumption: 16 },
            { period: '2024-08', reading: 419, consumption: 14 },
            { period: '2024-10', reading: 425, consumption: 6 },
            { period: '2025-01', reading: 427, consumption: 2 },
            { period: '2025-04', reading: 434, consumption: 7 },
            { period: '2025-06', reading: 446, consumption: 12 },
            { period: '2025-08', reading: 459, consumption: 13 },
            { period: '2026-02', reading: 462, consumption: 3 },
            { period: '2026-07', reading: 467, consumption: 5 },
            { period: '2026-08', reading: 481, consumption: 14 },
            { period: '2026-09', reading: 490, consumption: 9 },
          ],
          archiveMeta: { source: 'reconstructed', note: 'восстановлено по контрольным точкам — сверьте с квитанциями' }
        },
        internet: { rate: 600, enabled: true, note: 'абонентская плата' }
      }
    },
    {
      id: 'obj-04',
      index: 4,
      label: 'кв. 102',
      account: '104924',
      els: '20ОХ833333',
      area: 52.60,
      owner: 'Василенко Е. А.',
      address: { full: 'г. Алушта, ул. Юбилейная, д. 38, кв. 102', city: 'Алушта' },
      management: 'ТСН «НАШ ДОМ»',
      notes: [
        'Эталонный пример ТЗ: капремонт 52,60 м² × 11,46 ₽ = 602,80 ₽/мес.',
        'Двухзонный счётчик (День/Ночь); интернет к объекту не подключён.',
        'Площадь и тарифы — строго по квитанции ТСН «НАШ ДОМ».'
      ],
      services: {
        maintenance: { rate: 29.00, enabled: true },
        caprepair:   { rate: 11.46, enabled: true },
        electricity: {
          account: '104924',
          category: 'ungasified_city',
          zones: 2,
          meter: { serial: '45458105', model: 'Меркурий 200.02', lastCheckDate: '2022-09-06', checkPeriodYears: 16 }
        },
        water: {
          account: '19050_ALU',
          accountNote: null,
          rateKey: 'actual_4796',
          meter: { serial: null, model: null, lastCheckDate: null, checkPeriodYears: null, note: 'нет данных госповерки' },
          archive: [
            { period: '2023-11', reading: 295, consumption: 0 },
            { period: '2023-12', reading: 298, consumption: 3 },
            { period: '2024-02', reading: 303, consumption: 5 },
            { period: '2024-03', reading: 311, consumption: 8 },
            { period: '2024-04', reading: 322, consumption: 11 },
            { period: '2024-05', reading: 338, consumption: 16 },
            { period: '2024-06', reading: 357, consumption: 19 },
            { period: '2024-07', reading: 374, consumption: 17 },
            { period: '2024-08', reading: 389, consumption: 15 },
            { period: '2024-09', reading: 400, consumption: 11 },
            { period: '2024-10', reading: 407, consumption: 7 },
            { period: '2024-11', reading: 411, consumption: 4 },
            { period: '2025-03', reading: 417, consumption: 6 },
            { period: '2025-04', reading: 426, consumption: 9 },
            { period: '2025-05', reading: 441, consumption: 15 },
            { period: '2025-06', reading: 456, consumption: 15 },
            { period: '2025-07', reading: 469, consumption: 13 },
            { period: '2025-08', reading: 485, consumption: 16 },
            { period: '2026-01', reading: 485, consumption: 0 },
            { period: '2026-02', reading: 499, consumption: 14 },
            { period: '2026-04', reading: 509, consumption: 10 },
            { period: '2026-06', reading: 517, consumption: 8 },
            { period: '2026-07', reading: 517, consumption: 0 },
            { period: '2026-08', reading: 526, consumption: 9 },
            { period: '2026-09', reading: 540, consumption: 14 },
            { period: '2026-10', reading: 550, consumption: 10 },
          ],
          archiveMeta: { source: 'reconstructed', note: 'восстановлено по контрольным точкам — сверьте с квитанциями' }
        },
        internet: { rate: 0, enabled: false, note: 'услуга не подключена' }
      }
    },
    {
      id: 'obj-05',
      index: 5,
      label: 'кв. 108',
      account: '104987',
      els: '10ОХ833277',
      area: 37.90,
      owner: 'Василенко Е. Б.',
      address: { full: 'г. Алушта, ул. Юбилейная, д. 38, кв. 108', city: 'Алушта' },
      management: 'ТСН «НАШ ДОМ»',
      notes: [
        'Одноставочный счётчик, тариф «Негазифицирован + город».',
        'Площадь и тарифы — строго по квитанции ТСН «НАШ ДОМ».'
      ],
      services: {
        maintenance: { rate: 29.00, enabled: true },
        caprepair:   { rate: 11.46, enabled: true },
        electricity: {
          account: '104987',
          category: 'ungasified_city',
          zones: 1,
          meter: { serial: '41286426', model: 'Меркурий 201 5-50', lastCheckDate: '2020-01-20', checkPeriodYears: 16 }
        },
        water: {
          account: '19056_ALU',
          accountNote: null,
          rateKey: 'actual_4796',
          meter: { serial: null, model: null, lastCheckDate: null, checkPeriodYears: null, note: 'нет данных госповерки' },
          archive: [],
          archiveMeta: { source: 'none', note: 'архив показаний не предоставлен' }
        },
        internet: { rate: 600, enabled: true, note: 'абонентская плата' }
      }
    },
    {
      id: 'obj-06',
      index: 6,
      label: 'дом',
      account: '010588',
      els: null,
      area: 120.00,
      owner: 'Василенко Е. А.',
      address: { full: 'с. Перевальное, ул. Учительская, д. 1816/040701', city: 'Перевальное' },
      management: null,
      notes: [
        'ИЖС: содержание МКД и капремонт не начисляются.',
        'Сельский тариф электроэнергии, интернет 750 ₽/мес.',
        'Лицевой счёт Вода Крыма уточняется — вода считается по средним расходам.'
      ],
      services: {
        maintenance: { rate: 0, enabled: false, note: 'ИЖС — не начисляется' },
        caprepair:   { rate: 0, enabled: false, note: 'ИЖС — не начисляется' },
        electricity: {
          account: '010588',
          category: 'village',
          zones: 1,
          meter: { serial: '06130550', model: 'AD13 A 2 FLRsZR-Tx', lastCheckDate: '2022-01-01', checkPeriodYears: 16 }
        },
        water: {
          account: null,
          accountNote: 'данные уточняются — лицевой счёт Вода Крыма не указан в квитанции',
          rateKey: 'actual_4796',
          meter: { serial: null, model: null, lastCheckDate: null, checkPeriodYears: null, note: 'нет данных госповерки' },
          archive: [],
          archiveMeta: { source: 'none', note: 'архив показаний не предоставлен' }
        },
        internet: { rate: 750, enabled: true, note: 'сельский тариф' }
      }
    }
  ];

  /* ----------------------------------------------------------- ВАЛИДАТОР --- */
  /** Проверка целостности data-слоя: её показывают раздел «Данные» и npm run validate */
  function validate() {
    var problems = [];
    var serviceIds = SERVICES.map(function (s) { return s.id; });
    var seen = {};

    if (!OBJECTS.length) problems.push('Реестр объектов пуст');

    OBJECTS.forEach(function (o) {
      var who = 'Объект № ' + o.index + ' (' + o.id + ')';
      if (seen[o.id]) problems.push(who + ': повторяющийся идентификатор');
      seen[o.id] = true;
      if (!o.label || !o.address || !o.address.full) problems.push(who + ': не заполнены название или адрес');
      if (!(o.area > 0)) problems.push(who + ': площадь должна быть больше нуля');
      if (!o.owner) problems.push(who + ': не указан собственник');
      if (!o.account) problems.push(who + ': не указан лицевой счёт Крымэнерго');

      serviceIds.forEach(function (sid) {
        var svc = o.services[sid];
        if (!svc) { problems.push(who + ': нет услуги «' + sid + '»'); return; }
        if (sid === 'maintenance' || sid === 'caprepair') {
          if (typeof svc.rate !== 'number' || svc.rate < 0) problems.push(who + ': тариф ' + sid + ' должен быть числом ≥ 0');
        }
      });

      var el = o.services.electricity;
      if (el) {
        var cat = ELECTRICITY_TARIFFS[el.category];
        if (!cat) problems.push(who + ': неизвестная категория электроэнергии «' + el.category + '»');
        else {
          var scale = el.zones >= 2 ? 'day' : 'single';
          if (!cat.scales[scale]) problems.push(who + ': для ' + el.zones + ' зон нет шкалы «' + scale + '»');
        }
        var m = el.meter || {};
        if (m.lastCheckDate && !/^\d{4}-\d{2}-\d{2}$/.test(m.lastCheckDate)) problems.push(who + ': некорректная дата госповерки');
        if (m.lastCheckDate && !(m.checkPeriodYears > 0)) problems.push(who + ': указана дата поверки, но не указан МПИ');
      }

      var water = o.services.water;
      if (water) {
        if (water.rateKey && !WATER_TARIFFS[water.rateKey]) problems.push(who + ': неизвестный тариф воды «' + water.rateKey + '»');
        if (!water.account && !water.accountNote) problems.push(who + ': нет лицевого счёта воды и пометки «данные уточняются»');
        var prev = null;
        (water.archive || []).forEach(function (rec) {
          if (!/^\d{4}-\d{2}$/.test(rec.period || '')) problems.push(who + ': некорректный период в архиве водомера (' + rec.period + ')');
          if (typeof rec.reading !== 'number' || typeof rec.consumption !== 'number') problems.push(who + ': в архиве водомера не хватает reading/consumption');
          if (rec.consumption < 0) problems.push(who + ': отрицательный расход в архиве водомера');
          if (prev && rec.reading < prev.reading) problems.push(who + ': показания водомера убывают (' + prev.period + ' → ' + rec.period + ')');
          if (prev && Math.abs((rec.reading - prev.reading) - rec.consumption) > 0.001) {
            problems.push(who + ': расход не сходится с показаниями (' + rec.period + ')');
          }
          prev = rec;
        });
      }
    });

    WATER_TARIFF_ORDER.forEach(function (k) {
      if (!WATER_TARIFFS[k]) problems.push('В порядке тарифов воды неизвестный ключ «' + k + '»');
    });
    if (!WATER_TARIFFS[WATER_DEFAULT_RATE_KEY]) problems.push('Тариф воды по умолчанию отсутствует в справочнике');
    WATER_TARIFF_SCHEDULE_DEFAULT.forEach(function (row) {
      if (!WATER_TARIFFS[row.rateKey]) problems.push('В базовом графике воды неизвестный тариф «' + row.rateKey + '»');
    });
    if (SERVICES.length !== 5) problems.push('Ожидается 5 услуг в справочнике, найдено ' + SERVICES.length);

    return {
      ok: problems.length === 0,
      problems: problems,
      objects: OBJECTS.length,
      services: SERVICES.length,
      meters: OBJECTS.length * 2,
      archiveRecords: OBJECTS.reduce(function (acc, o) { return acc + ((o.services.water.archive || []).length); }, 0),
      checkedAt: new Date().toISOString()
    };
  }

  /* -------------------------------------------------------------- ЭКСПОРТ -- */
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    }
    return value;
  }

  var Data = {
    APP: APP,
    RULES: RULES,
    SERVICES: SERVICES,
    OBJECTS: OBJECTS,
    ELECTRICITY_TARIFFS: ELECTRICITY_TARIFFS,
    WATER_TARIFFS: WATER_TARIFFS,
    WATER_TARIFF_ORDER: WATER_TARIFF_ORDER,
    WATER_DEFAULT_RATE_KEY: WATER_DEFAULT_RATE_KEY,
    WATER_TARIFF_SCHEDULE_DEFAULT: WATER_TARIFF_SCHEDULE_DEFAULT,
    validate: validate
  };

  global.ZHKX = global.ZHKX || {};
  global.ZHKX.Data = deepFreeze(Data);
})(typeof window !== 'undefined' ? window : globalThis);
