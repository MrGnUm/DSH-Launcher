'use strict';
// Запуск dsh и доведение окна до GUI (вопросы при запуске, ожидание порта).
const util = require('util');
const state = require('./state');
const i18n = require('./i18n');
const { tr } = i18n;
const { esc } = require('./util');
const { DSH_ARGS, PLAIN_URL } = require('./env');
const launcher = require('./launcher'); // общий реестр (наполняет main.js)

/* ---------------- запуск dsh и доведение окна до GUI ---------------- */

// Защита от повторного запуска: двойной клик «Проверить ещё раз» или
// «Установить» вызвал бы launchDsh дважды — второй spawn перезаписал бы
// dshProc, и первый процесс остался бы без присмотра (не убит при закрытии).


function ourDshAlive() {
  return state.weStartedDsh && state.dshProc && state.dshProc.exitCode === null && !state.dshFatal;
}

async function launchDsh() {
  if (state.launching || ourDshAlive()) {
    console.log('[launcher] запуск dsh уже идёт — повторный вызов пропущен');
    return;
  }
  state.launching = true;
  try {
    if (await launcher.offerLauncherUpdate()) return; // перезапуск в новую версию — dsh поднимет она
    if (state.stopping) return;
    await launcher.offerDshUpdate();
    if (state.stopping) return;
    await launcher.offerMarketIfMissing();
    if (state.stopping) return;
    void launcher.refreshAvailableUpdates(); // отложенное обновление — пунктом в «Справке»
    await launchDshInner();
  } finally {
    state.launching = false;
  }
}

async function launchDshInner() {
  launcher.showPage(() => launcher.showStatus(tr('Запуск DeepSeek Harness…', 'Starting DeepSeek Harness…'), tr(
    `<p>Запускаю <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>Жду, пока сервис поднимется…</p>`,
    `<p>Running <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>Waiting for the service to come up…</p>`)));
  launcher.startDsh();

  const up = await launcher.waitForPort();
  if (!up) {
    launcher.showPage(() => launcher.showStatus(tr('Не удалось запустить dsh', 'Failed to start dsh'), tr(
      `<p>Процесс не поднял сервис на <code>${PLAIN_URL}</code>.<br>
         Проверьте, что команда запускается в терминале:
         <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>
         Последние строки журнала:</p>`,
      `<p>The process did not bring up the service at <code>${PLAIN_URL}</code>.<br>
         Check that the command runs in a terminal:
         <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>
         Latest log lines:</p>`) + launcher.stderrBlock(), true));
    launcher.startWatchdog(); // если dsh запустят вручную — окно оживёт само
    return;
  }

  // Порт уже поднят нами: проверка watchdog, начатая во время запуска и
  // завершившаяся после, не должна принять это за перезапуск dsh.
  state.portState = 'up';
  const url = state.authUrl || (await launcher.waitForAuthUrl());
  if (url) {
    await launcher.loadInWin(url); // обмен токена на куки, затем редирект на чистый URL
  } else if (await launcher.plainUrlIsAuthed()) {
    await launcher.loadInWin(PLAIN_URL); // старое куки ещё валидно
  } else {
    launcher.showPastePage();
  }
  launcher.startWatchdog();
}

module.exports = { launchDsh, launchDshInner };
