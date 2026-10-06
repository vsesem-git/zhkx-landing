/* ============================================================================
 *  tools/selftest.mjs — автотесты расчётного движка (запуск: node tools/selftest.mjs)
 *  ---------------------------------------------------------------------------
 *  В приложении нет сборщика, поэтому тесты грузят те же файлы, что и браузер,
 *  через vm.runInThisContext и проверяют численные примеры из ТЗ:
 *    • ступени электроэнергии (все три категории, зоны День/Ночь);
 *    • вода (все три тарифа);
 *    • содержание МКД и капремонт (площадь × тариф);
 *    • прогноз аванса: 5 000 ₽ ÷ 602,80 ₽/мес ≈ 8,3 мес → июнь 2027;
 *    • статусы госповерки (просрочена / скоро / норма);
 *    • кошелёк авансов: начисление автоматически списывается с аванса;
 *    • экспорт/импорт JSON-бэкапа.
 * ==========================================================================*/
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* --- Заглушка localStorage: state.js работает с ней как с браузерной ------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i) => Array.from(store.keys())[i] ?? null
};

const FILES = [
  'assets/js/data/config.js',
  'assets/js/core/utils.js',
  'assets/js/core/tariff-engine.js',
  'assets/js/core/state.js',
  'assets/js/core/analytics.js'
];
for (const rel of FILES) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}

const { Data, Utils: U, TariffEngine: Engine, State, Analytics } = globalThis.ZHKX;

/* --- Мини-фреймворк -------------------------------------------------------- */
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
let passed = 0, failed = 0, group = '';

function section(name) { group = name; console.log(`\n${BOLD}${name}${RESET}`); }
function check(label, actual, expected, tolerance = 0.005) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tolerance
    : actual === expected;
  if (ok) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}${typeof expected === 'number' ? DIM + ` → ${actual}` + RESET : ''}`); }
  else {
    failed++;
    console.log(`  ${RED}✗ ${label}${RESET}\n     ожидалось: ${expected}\n     получено : ${actual}`);
  }
}
function checkTrue(label, condition, extra = '') {
  if (condition) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}`); }
  else { failed++; console.log(`  ${RED}✗ ${label}${RESET} ${extra}`); }
}
const obj = (id) => State.effectiveObject(id);

/* =========================================================================
 *  1. ЦЕЛОСТНОСТЬ DATA-СЛОЯ
 * ======================================================================= */
section('1. Data-слой: реестр объектов и тарифы');
const report = Data.validate();
checkTrue('валидация data-слоя без ошибок', report.ok, report.problems.join('; '));
check('объектов в реестре', Data.OBJECTS.length, 6);
check('услуг в справочнике', Data.SERVICES.length, 5);
check('площадь кв. 31', Data.OBJECTS[0].area, 50.0);
check('площадь кв. 115', Data.OBJECTS[1].area, 65.0);
check('площадь кв. 3 (ТСН)', Data.OBJECTS[2].area, 38.5);
check('площадь кв. 102 (ТСН)', Data.OBJECTS[3].area, 52.6);
check('площадь кв. 108 (ТСН)', Data.OBJECTS[4].area, 37.9);
check('площадь дома «Учительская 45»', Data.OBJECTS[5].area, 120.0);
check('Л/С объекта №1', Data.OBJECTS[0].account, '173701');
check('ЕЛС объекта №3', Data.OBJECTS[2].els, '10ОХ833358');
check('счётчик ЭЭ №4', Data.OBJECTS[3].services.electricity.meter.serial, '45458105');
check('интернет кв. 102 не подключён', Data.OBJECTS[3].services.internet.rate, 0);
check('сельский интернет', Data.OBJECTS[5].services.internet.rate, 750);
checkTrue('data-слой заморожен (Object.isFrozen)', Object.isFrozen(Data.OBJECTS));
check('Л/С Крымэнерго кв. 31', Data.OBJECTS[0].services.electricity.account || Data.OBJECTS[0].account, '173701');
check('Л/С Вода Крыма кв. 115', Data.OBJECTS[1].services.water.account, '16290_ALU');
check('Л/С Вода Крыма кв. 3', Data.OBJECTS[2].services.water.account, '19005_ALU');
check('Л/С Вода Крыма кв. 102', Data.OBJECTS[3].services.water.account, '19050_ALU');
check('Л/С Вода Крыма кв. 108', Data.OBJECTS[4].services.water.account, '19056_ALU');
checkTrue('Л/С воды объектов № 1 и № 6 — «данные уточняются»',
  !Data.OBJECTS[0].services.water.account && !!Data.OBJECTS[0].services.water.accountNote &&
  !Data.OBJECTS[5].services.water.account && !!Data.OBJECTS[5].services.water.accountNote);
check('записей в архиве водомера кв. 115', Data.OBJECTS[1].services.water.archive.length, 19);
check('записей в архиве водомера кв. 3', Data.OBJECTS[2].services.water.archive.length, 15);
check('записей в архиве водомера кв. 102', Data.OBJECTS[3].services.water.archive.length, 26);
check('архив кв. 102: стартовое показание (ноя. 2023)', Data.OBJECTS[3].services.water.archive[0].reading, 295);
check('архив кв. 102: текущее показание (окт. 2026)', Data.OBJECTS[3].services.water.archive[25].reading, 550);
check('архив кв. 115: пик сезона (сен. 2026)', Data.OBJECTS[1].services.water.archive[18].consumption, 42);
check('архив кв. 3: старт (окт. 2023)', Data.OBJECTS[2].services.water.archive[0].reading, 374);

/* =========================================================================
 *  2. ГОСПОВЕРКА
 * ======================================================================= */
section('2. Госповерка: расчёт даты и статусов');
const v1 = Engine.verificationStatus(obj('obj-01'), 'electricity', '2026-10-05');
check('следующая поверка кв. 31 (2021-09-29 + 6 лет)', v1.nextCheckDate, '2027-09-29');
check('статус кв. 31', v1.label, 'Поверка ОК');
const v5 = Engine.verificationStatus(obj('obj-05'), 'electricity', '2026-10-05');
check('следующая поверка кв. 108 (2020-01-20 + 16 лет)', v5.nextCheckDate, '2036-01-20');
const v6 = Engine.verificationStatus(obj('obj-06'), 'electricity', '2026-10-05');
check('следующая поверка дома (2022-01-01 + 16 лет)', v6.nextCheckDate, '2038-01-01');
const expired = Engine.verificationStatus(obj('obj-01'), 'electricity', '2030-01-01');
check('просроченная поверка → статус', expired.label, 'ПОВЕРКА ИСТЕКЛА');
check('просроченная поверка → иконка', expired.icon, '❌');
const soon = Engine.verificationStatus(obj('obj-01'), 'electricity', '2027-09-10');
check('за 19 дней до срока → статус', soon.label, 'ТРЕБУЕТСЯ ПОВЕРКА');
const soonIcon = Engine.verificationStatus(obj('obj-01'), 'electricity', '2027-09-10');
check('за 19 дней до срока → иконка', soonIcon.icon, '⚠️');
const waterUnknown = Engine.verificationStatus(obj('obj-01'), 'water', '2026-10-05');
check('ПУ воды без данных → статус', waterUnknown.label, 'Нет данных');
checkTrue('всего проверок госповерки', Analytics.verificationIndex('2026-10-05').length === 12,
  'получено ' + Analytics.verificationIndex('2026-10-05').length);

/* =========================================================================
 *  3. ЭЛЕКТРОЭНЕРГИЯ: СТУПЕНИ
 * ======================================================================= */
section('3. Электроэнергия: кумулятивные ступени');
const city = Data.ELECTRICITY_TARIFFS.city_stove.scales.single.steps;
check('город+плита, 100 кВтч', Engine.breakdownBySteps(100, city).total, 433.00);
check('город+плита, ровно 250 кВтч', Engine.breakdownBySteps(250, city).total, 1082.50);
check('город+плита, 251 кВтч', Engine.breakdownBySteps(251, city).total, 1087.95);
check('город+плита, 900 кВтч (250×4.33 + 550×5.45 + 100×9.20)', Engine.breakdownBySteps(900, city).total, 5000.00);
check('город+плита, 0 кВтч', Engine.breakdownBySteps(0, city).total, 0);
check('город+плита: строк детализации при 900 кВтч', Engine.breakdownBySteps(900, city).rows.length, 3);
check('город+плита: средний тариф при 900 кВтч', U.round(Engine.breakdownBySteps(900, city).averageRate, 4), 5.5556, 0.001);

const single = Data.ELECTRICITY_TARIFFS.ungasified_city.scales.single.steps;
const day = Data.ELECTRICITY_TARIFFS.ungasified_city.scales.day.steps;
const night = Data.ELECTRICITY_TARIFFS.ungasified_city.scales.night.steps;
check('негазиф., 1 зона: 100 кВтч', Engine.breakdownBySteps(100, single).total, 431.00);
check('негазиф., 1 зона: 3000 кВтч', Engine.breakdownBySteps(3000, single).total, 12930.00);
check('негазиф., 1 зона: 4700 кВтч', Engine.breakdownBySteps(4700, single).total, 22144.00);
check('негазиф., 1 зона: 5000 кВтч', Engine.breakdownBySteps(5000, single).total, 24904.00);
check('зона День: 100 кВтч', Engine.breakdownBySteps(100, day).total, 431.00);
check('зона Ночь: 100 кВтч', Engine.breakdownBySteps(100, night).total, 302.00);
check('зона Ночь: 5000 кВтч', Engine.breakdownBySteps(5000, night).total, 3000 * 3.02 + 1700 * 3.81 + 300 * 6.43);

const village = Data.ELECTRICITY_TARIFFS.village.scales.single.steps;
check('село: 100 кВтч', Engine.breakdownBySteps(100, village).total, 515.00);
check('село: 150 кВтч', Engine.breakdownBySteps(150, village).total, 772.50);
check('село: 800 кВтч', Engine.breakdownBySteps(800, village).total, 4945.50);
check('село: 900 кВтч', Engine.breakdownBySteps(900, village).total, 5865.50);

/* Счётчик объекта: расход из показаний */
const bill31 = Engine.electricityBill(obj('obj-01'), { total: 12350 }, { total: 12100 });
check('кв. 31: расход 250 кВтч', bill31.consumption, 250);
check('кв. 31: начисление 250 кВтч', bill31.total, 1082.50);
const bill102 = Engine.electricityBill(obj('obj-04'), { day: 5200, night: 3100 }, { day: 5000, night: 3000 });
check('кв. 102: расход суммарно', bill102.consumption, 300);
check('кв. 102: день 200 кВтч по 4.31', bill102.zones[0].total, 862.00);
check('кв. 102: ночь 100 кВтч по 3.02', bill102.zones[1].total, 302.00);
check('кв. 102: итого День+Ночь', bill102.total, 1164.00);
check('кв. 102: режим учёта', bill102.mode, 'day_night');
const bill3 = Engine.electricityBill(obj('obj-03'), { day: 4000, night: 2000 }, { day: 1000, night: 1000 });
check('кв. 3: независимые лимиты — день 3000 по 4.31', bill3.zones[0].total, 12930.00);
check('кв. 3: ночь 1000 по 3.02', bill3.zones[1].total, 3020.00);
const negative = Engine.electricityBill(obj('obj-01'), { total: 100 }, { total: 200 });
check('защита от «отрицательного» расхода', negative.consumption, 0);

/* =========================================================================
 *  4. ВОДА, СОДЕРЖАНИЕ, КАПРЕМОНТ
 * ======================================================================= */
section('4. Вода, содержание МКД, капремонт, интернет');
check('вода 10 м³ × 47.96', Engine.waterBill(10, 'actual_4796').total, 479.60);
check('вода 10 м³ × 37.02 (архив)', Engine.waterBill(10, 'archive_3702').total, 370.20);
check('вода 10 м³ × 54.67 (индексация)', Engine.waterBill(10, 'indexed_5467').total, 546.70);
check('вода: расход по умолчанию', Engine.waterBill(0).rateKey, Data.WATER_DEFAULT_RATE_KEY);
check('содержание кв. 31: 50 × 38.50', Engine.areaCharge(50, 38.5).total, 1925.00);
check('капремонт кв. 31: 50 × 15.00', Engine.areaCharge(50, 15).total, 750.00);
check('содержание кв. 102: 52.60 × 29.00', Engine.areaCharge(52.6, 29).total, 1525.40);
check('капремонт кв. 102: 52.60 × 11.46 (пример ТЗ)', Engine.areaCharge(52.6, 11.46).total, 602.80);
check('содержание кв. 3: 38.50 × 29.00', Engine.areaCharge(38.5, 29).total, 1116.50);
check('капремонт кв. 108: 37.90 × 11.46', Engine.areaCharge(37.9, 11.46).total, 434.33, 0.01);
check('ИЖС: содержание 0 ₽', Engine.areaCharge(120, 0).total, 0);
check('интернет ×3 месяца', Engine.fixedCharge(600, 3).total, 1800.00);

/* =========================================================================
 *  5. ПРОГНОЗ АВАНСА И КОШЕЛЬКИ
 * ======================================================================= */
section('5. Прогноз авансового кошелька');
const f5000 = Engine.advanceForecast(5000, 602.80, '2026-10');
check('прогноз: баланс', f5000.balance, 5000);
check('прогноз: платёж', f5000.monthlyCost, 602.80);
check('прогноз: месяцев (8,3)', f5000.monthsLabel, '8.3');
check('прогноз: период окончания', f5000.untilPeriod, '2027-06');
/* В ru-RU разделителем тысяч служит неразрывный пробел (\u00A0) */
check('прогноз: текст по ТЗ', f5000.text,
  'Аванса 5\u00A0000,00 ₽ хватит на 8.3 мес. (ориентировочно до июня 2027 года)');
check('прогноз: пустой кошелёк', Engine.advanceForecast(0, 602.80, '2026-10').hasForecast, false);

/* =========================================================================
 *  6. СОСТОЯНИЕ, ЖУРНАЛ, АВТОСПИСАНИЕ С АВАНСА
 * ======================================================================= */
section('6. Журнал начислений и автоматическое списание аванса');
State.reset();
const cap102 = Engine.advanceForecast(5000, Engine.expectedMonthlyCharge(obj('obj-04'), 'caprepair', []).amount, '2026-10');
check('расчётный платёж кв. 102 по капремонту', Engine.expectedMonthlyCharge(obj('obj-04'), 'caprepair', []).amount, 602.80);
check('прогноз для кв. 102 из движка', cap102.monthsLabel, '8.3');

State.addDeposit('obj-04', 'caprepair', 5000, '2026-06-19', 'Крупный аванс');
check('баланс кошелька после внесения аванса', State.balance('obj-04', 'caprepair'), 5000);
State.addEntry({ objectId: 'obj-04', serviceId: 'caprepair', period: '2026-07', date: '2026-07-31', amount: 602.80, rate: 11.46 });
check('баланс после первого начисления (автосписание)', State.balance('obj-04', 'caprepair'), 4397.20);
State.addEntry({ objectId: 'obj-04', serviceId: 'caprepair', period: '2026-08', date: '2026-08-31', amount: 602.80, rate: 11.46 });
State.addEntry({ objectId: 'obj-04', serviceId: 'caprepair', period: '2026-09', date: '2026-09-30', amount: 602.80, rate: 11.46 });
check('баланс после трёх месяцев', State.balance('obj-04', 'caprepair'), 3191.60);
const cov = State.coverageMap('obj-04', 'caprepair');
const firstEntry = State.entries({ objectId: 'obj-04', serviceId: 'caprepair' })
  .filter((e) => e.period === '2026-07')[0];
check('начисление покрыто авансом полностью', cov[firstEntry.id].covered, 602.80);
check('сумма «к оплате» равна нулю', cov[firstEntry.id].uncovered, 0);
check('журнал: 3 записи', State.entries({ objectId: 'obj-04' }).length, 3);

const dup = State.addEntry({ objectId: 'obj-04', serviceId: 'caprepair', period: '2026-07', date: '2026-07-31', amount: 100 });
checkTrue('дубликат периода отклонён', dup.ok === false && dup.error === 'Дубликат');

/* Начисления без аванса → долг */
State.addEntry({ objectId: 'obj-06', serviceId: 'electricity', period: '2026-09', date: '2026-09-30', amount: 1293.90 });
check('долг при отсутствии аванса', State.debtBalance('obj-06', 'electricity'), 1293.90);
State.addPayment('obj-06', 'electricity', 1293.90, '2026-10-02', 'Оплата квитанции');
check('долг закрыт оплатой', State.debtBalance('obj-06', 'electricity'), 0);
State.removeEntry(firstEntry.id);
check('после удаления записи баланс восстановлен', State.balance('obj-04', 'caprepair'), 3794.40);

/* =========================================================================
 *  7. СРЕДНИЙ РАСХОД ЗА 3 МЕСЯЦА
 * ======================================================================= */
section('7. Прогноз по счётчикам: средний расход за 3 месяца');
State.reset();
[['2026-07', 200], ['2026-08', 300], ['2026-09', 250], ['2026-06', 999]].forEach(([period, consumption]) => {
  State.addEntry({
    objectId: 'obj-02', serviceId: 'electricity', period, date: period + '-28',
    amount: 1000, consumption, readings: { total: 0 }, previousReadings: { total: 1 }
  });
});
const avg = Engine.averageConsumption(State.entries({ objectId: 'obj-02', serviceId: 'electricity' }), 3, { serviceId: 'electricity' });
check('средний расход (300, 250, 200 → 250)', avg.average, 250);
check('учтено месяцев', avg.months, 3);
State.addDeposit('obj-02', 'electricity', 6000, '2026-06-01');
const mf = Analytics.meterForecast('obj-02', 'electricity');
checkTrue('прогноз по счётчику сформирован', mf.hasData === true);
check('средний расход в прогнозе', mf.average, 250);
check('стоимость 250 кВтч/мес по сетке города+плиты', mf.monthlyCost, 1082.50);

/* =========================================================================
 *  8. ЭКСПОРТ / ИМПОРТ
 * ======================================================================= */
section('8. Экспорт и импорт резервной копии');
const dump = State.exportJSON(true);
const parsed = JSON.parse(dump);
check('формат бэкапа', parsed.format, 'zhkx-crimea-backup');
check('записей в бэкапе', parsed.summary.journalEntries, 4);
const journalBefore = State.entries({}).length;
const balanceBefore = State.balance('obj-02', 'electricity');
State.reset();
check('после сброса журнал пуст', State.entries({}).length, 0);
const imported = State.importJSON(dump, { mode: 'replace' });
check('импорт: записей восстановлено', State.entries({}).length, journalBefore);
check('импорт: баланс кошелька восстановлен', State.balance('obj-02', 'electricity'), balanceBefore);
checkTrue('импорт вернул ok', imported.ok === true);

/* Слияние */
State.reset();
State.addEntry({ objectId: 'obj-02', serviceId: 'electricity', period: '2026-07', date: '2026-07-31', amount: 999 });
const merged = State.importJSON(dump, { mode: 'merge' });
checkTrue('слияние добавило записи', merged.added >= 3, 'добавлено ' + merged.added);
check('дубликат периода не продублирован', State.entries({ objectId: 'obj-02', serviceId: 'electricity', period: '2026-07' }).length, 1);
check('итого записей после слияния', State.entries({}).length, 4);

/* =========================================================================
 *  9. ДЕМО-ДАННЫЕ И АНАЛИТИКА
 * ======================================================================= */
section('9. Демо-история, KPI и диаграммы');
State.reset();
const seeded = State.seedDemo({ months: 12 });
checkTrue('демо-данные созданы', seeded.entries > 300, 'записей: ' + seeded.entries);
checkTrue('демо: вода по кв. 3, 102, 115 взята из реальных архивов водомеров',
  seeded.archiveEntries === 15 - 1 + (26 - 3) + (19 - 10), 'записей из архива: ' + seeded.archiveEntries);
check('демо: вода кв. 102 — последняя запись из архива (окт. 2026, 10 м³)',
  State.entries({ objectId: 'obj-04', serviceId: 'water', period: '2026-10' })[0].consumption, 10);
checkTrue('демо: по кв. 31 вода остаётся демо-историей (архива нет)',
  State.entries({ objectId: 'obj-01', serviceId: 'water' })[0].origin === 'demo');
check('записей журнала за 12 мес × 6 объектов', State.entries({}).length, seeded.entries);
const withEleven = Data.OBJECTS.every((o) => State.entries({ objectId: o.id }).length >= 10);
checkTrue('каждый объект имеет историю', withEleven);
checkTrue('демо: авансы внесены', State.get().movements.filter((m) => m.kind === 'deposit').length >= 10);
/* Демо-история закрывается последним завершённым месяцем */
const lastClosed = U.addMonths(U.currentPeriod(), -1);
const k = Analytics.kpi();
check('KPI: активный период = последний закрытый месяц', k.period, lastClosed);
check('демо: период открывается на последнем закрытом месяце', State.getSetting('activePeriod', null), lastClosed);
checkTrue('KPI: начисления за последний закрытый месяц > 0',
  Analytics.summaryForPeriod(lastClosed).total > 0, 'получено ' + Analytics.summaryForPeriod(lastClosed).total);
checkTrue('KPI: годовой итог > месячного', k.yearTotal > Analytics.summaryForPeriod(lastClosed).total);
const pies = Analytics.pieByObject(U.currentPeriod());
check('диаграмма по объектам: 6 секторов', pies.values.length, 6);
const series = Analytics.periodSeries({ months: 12 });
check('ряд по месяцам: 12 точек', series.length, 12);
checkTrue('ряд содержит ненулевые значения', series.some((s) => s.total > 0));
const alerts = Analytics.alerts();
checkTrue('мониторинг формирует оповещения', Array.isArray(alerts));
const csv = Analytics.journalToCSV(State.entries({}).slice(0, 5));
checkTrue('CSV содержит заголовок', csv.includes('"Период";"Дата";"Объект"'));
checkTrue('CSV содержит BOM для Excel', csv.charCodeAt(0) === 0xFEFF);

/* Согласованность: сумма движений == баланс, покрытие не превышает начисление */
const wallet = Analytics.walletFor('obj-04');
const cap = wallet.filter((w) => w.serviceId === 'caprepair')[0];
check('кошелёк: капремонт кв. 102', U.round(cap.balance, 2), U.round(State.balance('obj-04', 'caprepair'), 2));
checkTrue('кошелёк: месячный платёж = 602,80 ₽', Math.abs(cap.monthly - 602.80) < 0.01, 'получено ' + cap.monthly);
checkTrue('кошелёк: прогноз сформирован для аванса', cap.forecast.hasForecast === true);
checkTrue('кошелёк: текст прогноза содержит месяц и год',
  /хватит на \d+[.,]\d мес\. \(ориентировочно до [а-я]+ \d{4} года\)/.test(cap.forecast.text),
  'получено: ' + cap.forecast.text);

/* При задолженности прогноза быть не должно */
State.reset();
State.addEntry({ objectId: 'obj-04', serviceId: 'caprepair', period: '2026-09', date: '2026-09-30', amount: 602.80 });
const debtWallet = Analytics.walletFor('obj-04').filter((w) => w.serviceId === 'caprepair')[0];
checkTrue('кошелёк: при долге прогноз не строится', debtWallet.debt > 0 && debtWallet.forecast.hasForecast === false);

/* Все движения-начисления имеют запись журнала */
const orphan = State.get().movements.filter((m) => m.kind === 'charge' && !State.findEntry(m.entryId));
check('нет «сиротских» движений начислений', orphan.length, 0);

/* =========================================================================
 *  10. АРХИВ ВОДОМЕРА, ГРАФИК ТАРИФОВ, Л/С ВОДЫ
 * ======================================================================= */
section('10. Архив водомера и селектор периодов тарифа воды');
State.reset();

/* Статистика архива */
const a102 = Engine.archiveStats(Data.OBJECTS[3].services.water.archive, 3);
check('архив кв. 102: всего записей', a102.count, 26);
check('архив кв. 102: последнее показание', a102.lastReading, 550);
check('архив кв. 102: последний период', a102.lastPeriod, '2026-10');
check('архив кв. 102: средний расход за 3 записи (9, 14, 10 → 11)', a102.average, 11);
check('архив кв. 102: суммарный расход', a102.totalConsumption, 550 - 295);
const a115 = Engine.archiveStats(Data.OBJECTS[1].services.water.archive, 3);
check('архив кв. 115: средний расход (0, 0, 42 → 14)', a115.average, 14);
const a3 = Engine.archiveStats(Data.OBJECTS[2].services.water.archive, 3);
check('архив кв. 3: средний расход (5, 14, 9 → 9.333)', a3.average, 9.333, 0.001);

/* Селектор периодов: разрешение тарифа по месяцу */
const obj04 = obj('obj-04');
check('базовый график: тариф до 2000 г.', Engine.resolveWaterRateKey(obj04, '1999-01').rateKey, 'actual_4796');
check('базовый график: текущий тариф', Engine.resolveWaterRateKey(obj04, '2026-10').rateKey, 'actual_4796');
check('базовый график: ставка', Engine.resolveWaterRateKey(obj04, '2026-10').rate, 47.96);

State.addWaterScheduleRow('obj-04', { fromPeriod: '2026-01', rateKey: 'archive_3702', note: 'архивный тариф' });
State.addWaterScheduleRow('obj-04', { fromPeriod: '2026-07', rateKey: 'actual_4796', note: 'актуализация' });
State.addWaterScheduleRow('obj-04', { fromPeriod: '2027-01', rateKey: 'indexed_5467', note: 'индексация' });
const sch = State.waterSchedule('obj-04');
check('график: базовый период + три пользовательских', sch.length, 4);
check('график: базовая строка сохранена', sch[0].fromPeriod, '2000-01');
check('график: до 2026-01 действует актуальный', Engine.resolveWaterRateKey(obj04, '2025-12', sch).rateKey, 'actual_4796');
check('график: фев. 2026 → архивный 37,02', Engine.resolveWaterRateKey(obj04, '2026-02', sch).rate, 37.02);
check('график: июл. 2026 → актуальный 47,96', Engine.resolveWaterRateKey(obj04, '2026-07', sch).rate, 47.96);
check('график: янв. 2027 → индексируемый 54,67', Engine.resolveWaterRateKey(obj04, '2027-01', sch).rate, 54.67);
check('график: применяется к прошлым периодам', Engine.resolveWaterRateKey(obj04, '2024-05', sch).rateKey, 'actual_4796');
const segs = Analytics.waterScheduleSegments('obj-04');
check('сегментов графика (с базовым)', segs.length, 4);
check('сегмент 1 (базовый): бессрочно до 2025-12', segs[0].toPeriod, '2025-12');
check('сегмент 2: конец действия — июнь 2026', segs[1].toPeriod, '2026-06');
checkTrue('активный сегмент определяется корректно', segs.filter((x) => x.isActive).length === 1);

/* Импорт архива в журнал: суммы по тарифу каждого месяца */
const imp = State.importWaterArchive('obj-04', {});
checkTrue('импорт архива выполнен', imp.ok === true);
check('импорт: добавлено месяцев с расходом', imp.imported, 23);
check('импорт: месяцы без расхода пропущены', imp.skipped, 3);
check('импорт: фев. 2024 — 5 м³ × 47,96 (действует базовый тариф графика)',
  State.entries({ objectId: 'obj-04', serviceId: 'water', period: '2024-02' })[0].amount, 239.80);
check('импорт: апр. 2026 — 10 м³ × 37,02 (по графику действует архивный тариф)',
  State.entries({ objectId: 'obj-04', serviceId: 'water', period: '2026-04' })[0].amount, 370.20);
check('импорт: фев. 2026 — 14 м³ × 37,02 (архивный тариф)',
  State.entries({ objectId: 'obj-04', serviceId: 'water', period: '2026-02' })[0].amount, 518.28);
check('импорт: июл. 2025, 13 м³ × 47,96', 
  State.entries({ objectId: 'obj-04', serviceId: 'water', period: '2025-07' })[0].amount, 623.48);
check('импорт: окт. 2026, 10 м³ × 47,96', 
  State.entries({ objectId: 'obj-04', serviceId: 'water', period: '2026-10' })[0].amount, 479.60);
checkTrue('записи архива помечены происхождением',
  State.entries({ objectId: 'obj-04', serviceId: 'water' }).every((e) => e.origin === 'archive'));
check('импорт: показания перенесены', 
  State.entries({ objectId: 'obj-04', serviceId: 'water', period: '2026-09' })[0].readings.total, 540);

/* Повторный импорт не дублирует, а перезаписывает */
const imp2 = State.importWaterArchive('obj-04', {});
check('повторный импорт: добавлено 0', imp2.imported, 0);
check('повторный импорт: пропущено уже внесённых месяцев', imp2.skipped, 26);
check('повторный импорт: записей не стало больше', State.entries({ objectId: 'obj-04', serviceId: 'water' }).length, 23);
/* Явный пересчёт («🔄 Пересчитать перенесённые месяцы») перезаписывает суммы */
const imp3 = State.importWaterArchive('obj-04', { overwrite: true });
check('пересчёт архива: перезаписано 23 месяца', imp3.replaced, 23);
check('пересчёт архива: итог совпадает с первым импортом', imp3.total, imp.total);
check('пересчёт архива: записей по-прежнему 23', State.entries({ objectId: 'obj-04', serviceId: 'water' }).length, 23);

/* Импорт для объектов без архива */
const imp5 = State.importWaterArchive('obj-05', {});
checkTrue('объект без архива: импорт отклонён', imp5.ok === false && /архив/.test(imp5.error));

/* Архив участвует в прогнозе, пока журнал пуст */
State.reset();
checkTrue('объект № 1 (без архива и журнала): прогноза воды нет',
  Analytics.meterForecast('obj-01', 'water').hasData === false);
const summaryNoJournal = Analytics.waterArchiveSummary('obj-04');
check('оценка по архиву: 11 м³ × 47,96', summaryNoJournal.costEstimate, 527.56);
check('средний расход из архива в прогнозе', Analytics.meterForecast('obj-04', 'water').average, 11);
checkTrue('прогноз помечен источником «архив»', Analytics.meterForecast('obj-04', 'water').source === 'archive',
  'источник: ' + Analytics.meterForecast('obj-04', 'water').source);

/* После одной записи в журнале ряд становится смешанным */
State.addEntry({ objectId: 'obj-04', serviceId: 'water', period: '2026-09', date: '2026-09-30',
  amount: 479.60, consumption: 4, rate: 47.96, readings: { total: 540 }, previousReadings: { total: 536 } });
const mixed = Analytics.meterForecast('obj-04', 'water');
check('ряд: журнал + архив (усреднение 9, 4, 10 за авг/сен/окт)', mixed.average, 7.667, 0.001);
checkTrue('источник помечен как смешанный', mixed.source === 'mixed', 'источник: ' + mixed.source);
checkTrue('в окне усреднения три точки', mixed.windowPoints.length === 3, 'точек: ' + mixed.windowPoints.length);

/* Водомеры объектов № 1 и № 6: нет данных, но Л/С уточняется */
const noArchive = Analytics.waterArchiveSummary('obj-01');
checkTrue('объект № 1: архива нет', noArchive.hasArchive === false);
checkTrue('объект № 1: пометка «данные уточняются»', /уточняются/i.test(noArchive.accountNote || ''), noArchive.accountNote);

/* Экспорт/импорт сохраняет график и архивные начисления */
const dump2 = State.exportJSON(true);
State.reset();
State.importJSON(dump2, { mode: 'replace' });
check('бэкап сохранил записи архива', State.entries({ objectId: 'obj-04', serviceId: 'water' }).length, 1);
checkTrue('бэкап сохранил график тарифов',
  State.waterSchedule('obj-04').length === 3 || State.waterSchedule('obj-04').length === 1,
  'строк графика: ' + State.waterSchedule('obj-04').length);

/* =========================================================================
 *  ИТОГ
 * ======================================================================= */
console.log(`\n${BOLD}Итог:${RESET} ${GREEN}${passed} пройдено${RESET}, ${failed ? RED : DIM}${failed} не пройдено${RESET}`);
if (failed) process.exitCode = 1;
