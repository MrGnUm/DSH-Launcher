'use strict';
// Общее состояние лаунчера — то, что читают и меняют разные части. Начальные
// значения задаёт main.js (там же, где раньше были объявления let).
module.exports = {
  win: null,                 // главное окно
  stopping: false,           // лаунчер закрывается
  dshBin: null,              // программа dsh (DSH_BIN; найденная может смениться)
  dshProc: null,             // процесс dsh, запущенный лаунчером
  weStartedDsh: false,       // dsh запустил лаунчер (при закрытии — остановить)
  dshFatal: false,           // dsh не запустился / упал — не перезапускать
  adoptedDsh: false,         // dsh «усыновлён» после самовозрождения
  adoptedOldPgid: null,      // группа исходного dsh до самовозрождения
  authUrl: null,             // URL с токеном, напечатанный dsh
  launching: false,          // идёт запуск dsh (вопросы об обновлениях и т. п.)
  restarting: false,         // перезапуск в новую версию после обновления
  relaunchRequested: false,  // «Перезапустить лаунчер» (настройки, «Обновить сейчас»)
  dshInstalledVersion: null, // версия dsh, проверенная при запуске
  currentPage: null,         // перерисовка текущей служебной страницы (смена языка)
  portState: null,           // null | 'up' | 'down' — порт dsh (авто-восстановление)
  dialogWin: null,           // окно-диалог
  dialogRender: null,        // перерисовка содержимого диалога: (copied) => void
  dialogCopyText: '',        // текст «Скопировать для отчёта»
  tray: null, // (перенесено при разбиении main.js)
  lastReportPath: null, // (перенесено при разбиении main.js)
};
