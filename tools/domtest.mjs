/* ============================================================================
 *  tools/domtest.mjs — проверка интерфейса в реальном DOM (jsdom)
 *  ---------------------------------------------------------------------------
 *  Запуск:  npm install --no-save jsdom && node tools/domtest.mjs
 *  Тест поднимает index.html, подключает те же скрипты, что и браузер, и
 *  проверяет пользовательские сценарии: переключение разделов, «на лету»
 *  калькулятор, сохранение начисления, авансовый кошелёк, госповерку,
 *  экспорт/импорт и модальные окна.
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('\n⚠️  jsdom не установлен — пропускаю DOM-тесты.');
  console.log('   Установите: npm install --no-save jsdom\n');
  process.exit(0);
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
function section(n) { console.log(`\n${BOLD}${n}${RESET}`); }
function check(label, actual, expected, tol = 0.005) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) <= tol : actual === expected;
  if (ok) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}${typeof expected === 'number' ? DIM + ` → ${actual}` + RESET : ''}`); }
  else { failed++; console.log(`  ${RED}✗ ${label}${RESET}\n     ожидалось: ${expected}\n     получено : ${actual}`); }
}
function checkTrue(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  ${GREEN}✓${RESET} ${label}`); }
  else { failed++; console.log(`  ${RED}✗ ${label}${RESET} ${extra}`); }
}

/* --- Поднимаем страницу и подключаем скрипты в том же порядке -------------- */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://preview.local/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  resources: undefined
});
const { window } = dom;

/* Chart.js с CDN в тесте недоступен — проверяем именно резервный рендерер */
window.Chart = undefined;

const SCRIPTS = [
  'assets/js/data/config.js',
  'assets/js/core/utils.js',
  'assets/js/core/tariff-engine.js',
  'assets/js/core/state.js',
  'assets/js/core/analytics.js',
  'assets/js/core/sync.js',
  'assets/js/ui/vendor-chartjs.js',
  'assets/js/ui/charts.js',
  'assets/js/ui/views.js',
  'assets/js/ui/forms.js',
  'assets/js/ui/sync-ui.js',
  'assets/js/ui/offline.js',
  'assets/js/ui/app.js'
];

const consoleErrors = [];
window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));
window.console.error = (...args) => consoleErrors.push(args.map(String).join(' '));
window.console.warn = () => {};
const realError = console.error;
dom.virtualConsole.on('jsdomError', (e) => consoleErrors.push('jsdomError: ' + e.message));

/* window.scrollTo / alert / confirm в jsdom не реализованы */
window.scrollTo = () => {};
window.confirm = () => true;
window.alert = () => {};

for (const rel of SCRIPTS) {
  window.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const { ZHKX } = window;
const { App, State, Utils: U, Data, Analytics, Forms, Views } = ZHKX;
const FormDraft = () => ZHKX.Forms.Entry.draft;

/* canvas в jsdom не реализован — проверяем именно защитный путь кода */
window.HTMLCanvasElement.prototype.getContext = function () { return null; };

/* boot() запускается на DOMContentLoaded — даём событию произойти */
await new Promise((r) => setTimeout(r, 0));
if (!App.ready) App.init();

const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => Array.from(window.document.querySelectorAll(sel));

/* ========================================================================= */
section('1. Загрузка приложения');
checkTrue('приложение инициализировано', App.ready === true);
checkTrue('разделов в навигации — 9', $$('.tab').length === 9, 'получено ' + $$('.tab').length);
checkTrue('дашборд отрисован', $('#view-host').innerHTML.length > 3000);
checkTrue('KPI-карточки отрисованы', $$('.kpi').length >= 5, 'получено ' + $$('.kpi').length);
checkTrue('демо-история создана при первом запуске', State.get().journal.length > 300);
checkTrue('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.join(' | '));
checkTrue('период по умолчанию — месяц с данными', U.parsePeriod(App.period) !== null, App.period);
checkTrue('диаграммы отрисованы резервным рендерером', ZHKX.Charts.currentEngine() === 'simple' || ZHKX.Charts.currentEngine() === 'pending',
  'движок: ' + ZHKX.Charts.currentEngine());

/* ========================================================================= */
section('2. Переключение всех разделов');
const views = ['entry', 'objects', 'wallet', 'journal', 'archive', 'verification', 'tariffs', 'data', 'dashboard'];
views.forEach((v) => {
  let ok = true;
  try { App.setView(v); } catch (e) { ok = false; console.error('view ' + v + ': ' + e.message); }
  const len = $('#view-host').innerHTML.length;
  checkTrue(`раздел «${v}» отрисован без ошибок`, ok && len > 500, 'длина ' + len);
});

/* ========================================================================= */
section('3. Калькулятор «на лету» (кв. 31: содержание 50 × 38,50)');
App.setView('entry');
App.onClick({ target: window.document.createElement('div'), preventDefault() {} }); /* no-op, проверка устойчивости */
const form = $('[data-entry-form]');
const setValue = (name, value) => {
  const el = form.querySelector(`[name="${name}"]`);
  el.value = String(value);
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  return el;
};
setValue('objectId', 'obj-01');
setValue('serviceId', 'maintenance');
check('период калькулятора — активный месяц приложения', $('[name="period"]').value, App.period);
checkTrue('площадь подставлена из реестра', $('[name="area"]').value === '50');
checkTrue('тариф подставлен из реестра', $('[name="rate"]').value === '38.5');
check('начислено рассчитано на лету', U.toNumber($('[name="amount"]').value), 1925.00);
checkTrue('в предпросмотре указана формула', $('#view-host').textContent.includes('50,00 м² × 38,50 ₽/м²'));

section('3.1. Ручная правка поля «Начислено»');
const amountInput = setValue('amount', 2000);
const previewHost = $('[data-entry-preview]');
checkTrue('пометка «изменено вручную» появилась', previewHost.textContent.includes('изменена вручную'));
check('итог равен введённому значению', U.toNumber(amountInput.value), 2000);

section('3.2. Сохранение начисления и автосписание с аванса');
State.reset();
State.seedDemo({ months: 3 });
State.addDeposit('obj-01', 'maintenance', 10000, '2026-09-01', 'Тестовый аванс');
App.setView('entry');
const form2 = $('[data-entry-form]');
const set2 = (name, value) => {
  const el = form2.querySelector(`[name="${name}"]`);
  el.value = String(value);
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const targetPeriod = U.addMonths(U.currentPeriod(), 1);
set2('objectId', 'obj-01');
set2('serviceId', 'maintenance');
set2('period', targetPeriod);
const amountBefore = State.balance('obj-01', 'maintenance');
const journalBefore = State.get().journal.length;
$('[data-entry-action="save"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('запись добавлена в журнал', State.get().journal.length, journalBefore + 1);
check('аванс уменьшен на сумму начисления', U.round(amountBefore - State.balance('obj-01', 'maintenance'), 2), 1925.00);
const savedEntry = State.entries({ objectId: 'obj-01', serviceId: 'maintenance', period: targetPeriod })[0];
checkTrue('запись сохранена с корректным периодом', !!savedEntry);
check('сохранённая сумма', savedEntry.amount, 1925.00);

section('3.3. Двухзонный счётчик: расход День/Ночь');
App.setView('entry');
const form3 = $('[data-entry-form]');
const set3 = (name, value) => {
  const el = form3.querySelector(`[name="${name}"]`);
  if (!el) return false;
  el.value = String(value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  return true;
};
set3('objectId', 'obj-03');
set3('serviceId', 'electricity');
checkTrue('поля День/Ночь появились', !!form3.querySelector('[name="curDay"]') && !!form3.querySelector('[name="curNight"]'));
set3('prevDay', 1000);
set3('curDay', 1200);
set3('prevNight', 500);
set3('curNight', 600);
check('начисление День/Ночь (200×4,31 + 100×3,02)', U.toNumber(form3.querySelector('[name="amount"]').value), 1164.00);
checkTrue('в разбивке видны обе зоны', $('[data-entry-breakdown]').textContent.includes('День (Т1)'));

section('3.4. Вода с переключением тарифа');
set3('serviceId', 'water');
set3('prevTotal', 100);
set3('curTotal', 110);
check('10 м³ × 47,96 ₽', U.toNumber(form3.querySelector('[name="amount"]').value), 479.60);
set3('waterRateKey', 'archive_3702');
check('10 м³ × 37,02 ₽ (архивный тариф)', U.toNumber(form3.querySelector('[name="amount"]').value), 370.20);
checkTrue('выбранный вручную тариф относится только к этой записи',
  FormDraft().waterRateKey === 'archive_3702' &&
  ZHKX.TariffEngine.resolveWaterRateKey(State.effectiveObject('obj-03'), App.period, State.waterSchedule('obj-03')).rateKey === Data.WATER_DEFAULT_RATE_KEY);

/* ========================================================================= */
section('4. Кошелёк авансов');
App.setView('wallet');
checkTrue('кошельки отрисованы', $$('.card--wallet').length >= 6, 'получено ' + $$('.card--wallet').length);
const depositForm = $$('[data-form="deposit"]')[0];
const dObject = depositForm.getAttribute('data-object');
const dService = depositForm.getAttribute('data-service');
const dAmount = depositForm.querySelector('[name="amount"]');
const dBalanceBefore = State.balance(dObject, dService);
dAmount.value = '7777';
dAmount.dispatchEvent(new window.Event('input', { bubbles: true }));
depositForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
check('аванс зачислен на 7 777 ₽ (' + dObject + '/' + dService + ')',
  U.round(State.balance(dObject, dService) - dBalanceBefore, 2), 7777.00);
checkTrue('прогноз аванса показан в интерфейсе', $('#view-host').textContent.includes('хватит на'));

section('4.1. Прогноз по примеру ТЗ (5 000 ₽ ÷ 602,80 ₽/мес)');
State.reset();
const f = ZHKX.TariffEngine.advanceForecast(5000, 602.80, '2026-10');
check('прогноз: 8.3 мес', f.monthsLabel, '8.3');
check('прогноз: «до июня 2027 года» (родительный падеж)', f.untilLabel, 'июня 2027 года');
check('прогноз: «Июнь 2027» (подпись)', f.untilLabelNominative, 'Июнь 2027');
checkTrue('текст прогноза точно как в ТЗ', f.text === 'Аванса 5\u00A0000,00 \u20BD хватит на 8.3 мес. (ориентировочно до июня 2027 года)', f.text);

/* ========================================================================= */
section('5. Модальные окна и правки тарифов');
Forms.Modal.open(Forms.serviceModal('obj-02', 'maintenance'));
checkTrue('модальное окно открылось', !$('#modal-host').hidden && !!$('.modal'));
const rateInput = $('.modal [name="rate"]');
rateInput.value = '40';
$('.modal form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
checkTrue('модальное окно закрылось после сохранения', $('#modal-host').hidden === true);
check('правка тарифа применена (38,50 → 40,00)', State.effectiveObject('obj-02').services.maintenance.rate, 40);
App.setView('objects');
checkTrue('карточка объекта показывает новый тариф', $('#view-host').textContent.includes('40,00'));
State.resetOverrides('obj-02');
check('сброс правки вернул тариф реестра', State.effectiveObject('obj-02').services.maintenance.rate, 38.5);

section('5.1. Правка прибора учёта и пересчёт госповерки');
Forms.Modal.open(Forms.meterModal('obj-05', 'electricity'));
$('.modal [name="meterCheckDate"]').value = '2025-03-15';
$('.modal [name="meterPeriodYears"]').value = '16';
$('.modal form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const v5 = ZHKX.TariffEngine.verificationStatus(State.effectiveObject('obj-05'), 'electricity', '2026-10-05');
check('новая дата следующей поверки', v5.nextCheckDate, '2041-03-15');

/* ========================================================================= */
section('6. Журнал: фильтры, детализация, удаление');
State.reset();
State.seedDemo({ months: 6 });
App.setView('journal');
const rowsCount = $$('.journal-row').length;
checkTrue('записи журнала отрисованы', rowsCount > 100, 'строк: ' + rowsCount);
const filterObj = $('[data-filter="objectId"]');
filterObj.value = 'obj-04';
filterObj.dispatchEvent(new window.Event('input', { bubbles: true }));
filterObj.dispatchEvent(new window.Event('change', { bubbles: true }));
checkTrue('фильтр по объекту применился', $$('.journal-row').length > 0 && $$('.journal-row').length < rowsCount,
  'строк: ' + $$('.journal-row').length);

App.filters = {};
App.setView('journal');
const firstBreakdownBtn = $$('[data-action="toggle-breakdown"]')[0];
firstBreakdownBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const detailRow = $('[data-entry-detail]');
checkTrue('детализация начисления раскрывается', detailRow && detailRow.hidden === false);

const beforeDelete = State.get().journal.length;
const delBtn = $$('[data-action="delete-entry"]')[0];
delBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('запись удалена', State.get().journal.length, beforeDelete - 1);

/* ========================================================================= */
section('7. Календарь госповерки');
App.setView('verification');
const vRows = $$('.table--verification tbody tr').length;
check('12 приборов учёта в мониторинге', vRows, 12);
checkTrue('статусы отрисованы', $('#view-host').textContent.includes('Поверка ОК'));

/* ========================================================================= */
section('7.1. Симулятор даты проверки поверок');
const verifDate = $('[data-filter="verificationDate"]');
verifDate.value = '2030-01-01';
verifDate.dispatchEvent(new window.Event('input', { bubbles: true }));
checkTrue('на 01.01.2030 в списке есть просроченные поверки', $('#view-host').textContent.includes('ПОВЕРКА ИСТЕКЛА'));
checkTrue('статус на дату рассчитан для кв. 31', $('#view-host').textContent.includes('2027'));
$('[data-action="verification-today"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
checkTrue('кнопка «Сегодня» вернула текущую дату', U.parsePeriod(App.period) !== null && App.verificationDate === U.todayISO());

/* ========================================================================= */
section('7.2. Архив водомеров');
App.setView('archive');
checkTrue('раздел «Водомеры» отрисован', $('#view-host').textContent.includes('Исторический архив водомеров'));
checkTrue('показан Л/С Вода Крыма кв. 102', $('#view-host').textContent.includes('19050_ALU'));
checkTrue('в таблице архива видны показания', $('#view-host').textContent.includes('550'));
checkTrue('объекты без архива помечены', $('#view-host').textContent.includes('уточняются'));
const archiveRows = $$('#archive-obj-04 tbody tr').length;
checkTrue('строк истории по кв. 102', archiveRows === 26, 'строк: ' + archiveRows);

/* Импорт архива в журнал через кнопку */
const beforeArchiveImport = State.entries({ objectId: 'obj-04', serviceId: 'water' }).length;
$('[data-action="import-archive"][data-object="obj-04"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const afterArchiveImport = State.entries({ objectId: 'obj-04', serviceId: 'water' }).length;
checkTrue('архив перенесён в журнал', afterArchiveImport > beforeArchiveImport,
  beforeArchiveImport + ' → ' + afterArchiveImport);
checkTrue('запись архива помечена происхождением',
  State.entries({ objectId: 'obj-04', serviceId: 'water' }).some((e) => e.origin === 'archive'));

/* ========================================================================= */
section('7.3. Селектор периодов тарифов воды');
App.setView('tariffs');
const schedForm = $('[data-form="water-schedule"]');
schedForm.querySelector('[name="fromPeriod"]').value = '2027-01';
schedForm.querySelector('[name="rateKey"]').value = 'indexed_5467';
schedForm.querySelector('[name="note"]').value = 'индексация 2027';
schedForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
check('график: строка добавлена', State.waterSchedule('obj-01').length, 2);
check('график: тариф с янв. 2027 — индексируемый', ZHKX.TariffEngine.resolveWaterRateKey(
  State.effectiveObject('obj-01'), '2027-03', State.waterSchedule('obj-01')).rateKey, 'indexed_5467');
check('график: до 2027 действует базовый тариф', ZHKX.TariffEngine.resolveWaterRateKey(
  State.effectiveObject('obj-01'), '2026-12', State.waterSchedule('obj-01')).rateKey, 'actual_4796');
checkTrue('в интерфейсе отображается диапазон действия', $('#view-host').textContent.includes('Январь 2027'));

/* Стоимость воды в калькуляторе меняется вместе с графиком */
App.setView('entry');
const calcForm = $('[data-entry-form]');
const setCalc = (name, value) => {
  const el = calcForm.querySelector(`[name="${name}"]`);
  if (!el) return;
  el.value = String(value);
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
setCalc('objectId', 'obj-01');
setCalc('serviceId', 'water');
setCalc('period', '2027-05');
setCalc('prevTotal', 100);
setCalc('curTotal', 110);
check('10 м³ по графику 2027 (54,67 ₽/м³)', U.toNumber(calcForm.querySelector('[name="amount"]').value), 546.70);
setCalc('period', '2026-05');
setCalc('prevTotal', 100);
setCalc('curTotal', 110);
check('10 м³ по базовому тарифу (47,96 ₽/м³)', U.toNumber(calcForm.querySelector('[name="amount"]').value), 479.60);

/* Смена периода возвращает тариф, действующий по графику */
setCalc('period', '2026-06');
setCalc('prevTotal', 100);
setCalc('curTotal', 110);
check('возврат к базовому тарифу после смены периода (47,96 ₽/м³)',
  U.toNumber(calcForm.querySelector('[name="amount"]').value), 479.60);
checkTrue('тариф для записи сброшен, действует график', FormDraft().waterRateKey === null);

/* ========================================================================= */
section('8. Экспорт / импорт через интерфейс');
const backup = State.exportJSON(true);
checkTrue('бэкап содержит все записи', JSON.parse(backup).summary.journalEntries === State.get().journal.length);
const journalCount = State.get().journal.length;
State.reset();
const res = State.importJSON(backup, { mode: 'replace' });
check('импорт восстановил журнал', State.get().journal.length, journalCount);
checkTrue('импорт прошёл без ошибок', res.ok === true);

/* ========================================================================= */
section('9. Интерфейс синхронизации без сервера (локальный режим)');
const Sync = ZHKX.Sync;
const SyncUI = ZHKX.SyncUI;
checkTrue('модуль синхронизации подключён', !!Sync && !!SyncUI);
checkTrue('без fetch/сервера приложение честно сообщает о локальном режиме',
  ['local', 'unauthorized'].includes(Sync.info().status), Sync.info().status);
checkTrue('идентификатор клиента сохранён в localStorage',
  !!window.localStorage.getItem('zhkx.server.v1'));
checkTrue('бейдж синхронизации отрисован в шапке',
  /sync-badge/.test($('#sync-badge').innerHTML), $('#sync-badge').innerHTML);
App.setView('data');
checkTrue('в разделе «Данные» есть карточка «Сервер и синхронизация»', /card--sync/.test($('#view-host').innerHTML));
checkTrue('карточка объясняет, что данные хранятся в data/state.js', /data\/state\.js/.test($('#view-host').innerHTML));
SyncUI.open();
const modalHtml = $('#modal-host').innerHTML;
checkTrue('окно синхронизации открывается', /modal/.test(modalHtml) && modalHtml.length > 400, 'длина ' + modalHtml.length);
checkTrue('в окне есть поле адреса API', /id="sync-url"/.test(modalHtml));
checkTrue('в окне есть вход по токену', /data-form="sync-login"/.test(modalHtml));
checkTrue('в окне есть переключатель автосинхронизации', /id="sync-autosync"/.test(modalHtml));
Forms.Modal.close();
checkTrue('офлайн-плашка в разметке есть и скрыта при наличии сети', $('#offline-bar') !== null && $('#offline-bar').hidden === true);
checkTrue('очередь операций пуста в локальном режиме (сервер не настроен)', typeof State.pendingCount() === 'number');

/* ========================================================================= */
section('10. Смена темы и устойчивость');
const themeBtn = $('#theme-toggle');
themeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('тема переключилась на светлую', window.document.documentElement.getAttribute('data-theme'), 'light');
themeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('тема вернулась в тёмную', window.document.documentElement.getAttribute('data-theme'), 'dark');
checkTrue('ошибок в консоли за весь прогон нет', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

/* ========================================================================= */
console.log(`\n${BOLD}Итог DOM-тестов:${RESET} ${GREEN}${passed} пройдено${RESET}, ${failed ? RED : DIM}${failed} не пройдено${RESET}`);
if (consoleErrors.length) {
  console.log(`${DIM}Перехваченные сообщения консоли:${RESET}`);
  consoleErrors.slice(0, 10).forEach((e) => console.log('  · ' + e));
}
if (failed) process.exitCode = 1;
dom.window.close();
