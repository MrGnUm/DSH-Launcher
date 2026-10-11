'use strict';
// Окно — чистая логика: пункты контекстного меню, горячие клавиши, размер
// окна, состояние GPU, имя и текст отчёта.
const { tr } = require('./i18n');

const WIN_DEFAULT = { width: 1440, height: 900 };
const WIN_MIN = { width: 760, height: 480 };

/* Контекстное меню по правому клику — по params события context-menu:
   в поле ввода — Вырезать / Копировать / Вставить / Выделить всё (доступность
   по editFlags); вне поля — Копировать (если есть выделение) и Выделить всё;
   на ссылке — ещё «Копировать адрес ссылки»; на слове с ошибкой — первой
   группой варианты исправления и «Добавить в словарь». Пункты — { action,
   label, enabled[, value] }, группы разделены { type: 'separator' }. */
function contextMenuItems(params) {
  const f = params.editFlags || {};
  const groups = [];
  if (params.misspelledWord) {
    const sugg = (params.dictionarySuggestions || []).slice(0, 5);
    groups.push([
      ...(sugg.length
        ? sugg.map((w) => ({ action: 'replace', label: w, value: w, enabled: true }))
        : [{ action: 'none', label: tr('Нет вариантов', 'No suggestions'), enabled: false }]),
      { action: 'addWord', label: tr('Добавить в словарь', 'Add to dictionary'), enabled: true },
    ]);
  }
  if (params.linkURL) {
    groups.push([{ action: 'copyLink', label: tr('Копировать адрес ссылки', 'Copy link address'), enabled: true }]);
  }
  if (params.isEditable) {
    groups.push([
      { action: 'cut', label: tr('Вырезать', 'Cut'), enabled: Boolean(f.canCut) },
      { action: 'copy', label: tr('Копировать', 'Copy'), enabled: Boolean(f.canCopy) },
      { action: 'paste', label: tr('Вставить', 'Paste'), enabled: Boolean(f.canPaste) },
    ]);
    groups.push([{ action: 'selectAll', label: tr('Выделить всё', 'Select all'), enabled: Boolean(f.canSelectAll) }]);
  } else {
    if (String(params.selectionText || '').trim()) {
      groups.push([{ action: 'copy', label: tr('Копировать', 'Copy'), enabled: true }]);
    }
    groups.push([{ action: 'selectAll', label: tr('Выделить всё', 'Select all'), enabled: true }]);
  }
  const items = [];
  for (const g of groups) {
    if (items.length) items.push({ type: 'separator' });
    items.push(...g);
  }
  return items;
}

/* Клавиша → действие «Вида» (имя из viewActions) или null — клавиша
   странице. code — физическая клавиша, не зависит от раскладки (RU/EN). */
function keyAction(input) {
  const c = input.control;
  if (input.key === 'F5' || (c && input.code === 'KeyR')) return input.shift ? 'reloadHard' : 'reload';
  if (c && (input.code === 'Equal' || input.code === 'NumpadAdd')) return 'zoomIn';
  if (c && (input.code === 'Minus' || input.code === 'NumpadSubtract')) return 'zoomOut';
  if (c && (input.code === 'Digit0' || input.code === 'Numpad0')) return 'zoomReset';
  if (c && !input.shift && input.code === 'KeyF') return 'find';
  if (input.key === 'F3') return input.shift ? 'findPrev' : 'findNext';
  if (input.key === 'F11') return 'fullscreen';
  if (c && input.code === 'Comma') return 'settings';
  return null;
}

/* Размер окна из сохранённого состояния: не меньше WIN_MIN и не больше
   рабочей области экрана (монитор могли сменить); мусор — размер по умолчанию. */
function windowSize(saved, workArea) {
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const fit = (v, def, min, max) => {
    const x = num(v) || def;
    return Math.round(Math.max(min, num(max) ? Math.min(x, max) : x));
  };
  const st = saved && typeof saved === 'object' ? saved : {};
  const wa = workArea || {};
  return {
    width: fit(st.width, WIN_DEFAULT.width, WIN_MIN.width, wa.width),
    height: fit(st.height, WIN_DEFAULT.height, WIN_MIN.height, wa.height),
    maximized: st.maximized === true,
  };
}

/* Состояние GPU-ускорения для «О программе». Причины отключения — как в
   начале main.js; markerAgeMs — возраст маркера сбоев сейчас (null — нет).
   Маркер при включённом GPU = отключится со следующего запуска. */
function gpuStatus(st) {
  const marker = st.markerAgeMs !== null && st.markerAgeMs < st.ttlMs;
  const daysLeft = marker ? Math.max(1, Math.ceil((st.ttlMs - st.markerAgeMs) / 86400000)) : 0;
  const reason = st.noGpuRequested ? (st.noGpuBySettings ? 'setting' : 'env')
    : st.disabledByMarker ? 'marker'
    : !st.hasRenderNode ? 'norender'
    : !st.hasEgl ? 'noegl'
    : null;
  return { on: reason === null, reason, marker, daysLeft };
}

/* Имя файла отчёта (по местному времени) и текст сведений «ключ: значение». */
function reportFileName(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `dsh-launcher-report-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.tar.gz`;
}

function reportInfoText(facts) {
  return facts.map(([k, v]) => `${k}: ${v === undefined || v === null || v === '' ? '—' : v}`).join('\n') + '\n';
}

module.exports = { WIN_DEFAULT, WIN_MIN, contextMenuItems, keyAction, windowSize, gpuStatus, reportFileName, reportInfoText };
