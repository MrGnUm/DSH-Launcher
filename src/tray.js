'use strict';
// Трей и работа в фоне; сигнал «агент закончил ответ».
const { app, Menu, Tray, Notification, nativeImage } = require('electron');
const path = require('path');
const state = require('./state');
const i18n = require('./i18n');
const { tr } = i18n;
const { loadSettings, PLAIN_URL } = require('./env');
const launcher = require('./launcher'); // общий реестр (наполняет main.js)

/* ---------------- трей и работа в фоне ---------------- */

// «Настройки → Окно»: closeToTray — крестик прячет окно в трей, dsh работает
// дальше (по умолчанию выключено: без поддержки трея на рабочем столе —
// в «чистом» GNOME нет — окно пропало бы без значка; вернуть его можно и
// повторным запуском лаунчера). attention — привлечь внимание, когда агент
// закончил ответ, а окно не в фокусе (по умолчанию включено).

let trayIcons = null;

const closeToTrayOn = () => (loadSettings() || {}).closeToTray === true;
const attentionOn = () => (loadSettings() || {}).attention !== false;
const attentionSoundOn = () => (loadSettings() || {}).attentionSound === true;

// Значок трея и он же с оранжевой точкой («агент закончил»).
function makeTrayIcons() {
  let base = nativeImage.createFromPath(path.join(__dirname, '..', 'icon.png'));
  if (base.isEmpty()) base = nativeImage.createFromPath('/usr/share/icons/hicolor/256x256/apps/dsh-launcher.png');
  const normal = base.isEmpty() ? base : base.resize({ width: 24, height: 24, quality: 'best' });
  if (normal.isEmpty()) return { normal, attention: normal };
  const { width: w, height: h } = normal.getSize();
  const px = Buffer.from(normal.toBitmap()); // BGRA
  const cx = w - 6, cy = h - 6, r = 5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r + 0.5) continue;
      const i = (y * w + x) * 4;
      const ring = d > r - 1.2; // тёмная обводка — точку видно и на светлой панели
      px[i] = ring ? 0x15 : 0x0b; px[i + 1] = ring ? 0x11 : 0x9e; px[i + 2] = ring ? 0x0f : 0xf5; px[i + 3] = 0xff;
    }
  }
  return { normal, attention: nativeImage.createFromBitmap(px, { width: w, height: h }) };
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: tr('Открыть DeepSeek Harness', 'Open DeepSeek Harness'), click: () => showMainWindow() },
    { label: tr('Перезапустить dsh…', 'Restart dsh…'), click: () => { showMainWindow(); void launcher.restartDsh(); } },
    { type: 'separator' },
    { label: tr('Выйти', 'Quit'), click: () => app.quit() },
  ]);
}

function setTray(on) {
  if (Boolean(state.tray) === Boolean(on)) return;
  if (on) {
    if (!trayIcons) trayIcons = makeTrayIcons();
    state.tray = new Tray(trayIcons.normal);
    state.tray.setToolTip('DeepSeek Harness');
    state.tray.setContextMenu(trayMenu());
    state.tray.on('click', () => showMainWindow());
    console.log('[launcher] трей включён: крестик прячет окно, dsh работает дальше');
  } else {
    state.tray.destroy();
    state.tray = null;
    console.log('[launcher] трей выключен');
    if (state.win && !state.win.isDestroyed() && !state.win.isVisible()) showMainWindow(); // не оставить окно спрятанным без значка
  }
}

function setTrayAttention(on) {
  if (!state.tray || !trayIcons) return;
  state.tray.setImage(on ? trayIcons.attention : trayIcons.normal);
  state.tray.setToolTip(on ? tr('DeepSeek Harness — агент закончил ответ', 'DeepSeek Harness — the agent has finished') : 'DeepSeek Harness');
}

function showMainWindow() {
  if (!state.win || state.win.isDestroyed()) return;
  const wasHidden = !state.win.isVisible();
  state.win.show();
  if (state.win.isMinimized()) state.win.restore();
  state.win.focus();
  state.win.flashFrame(false);
  setTrayAttention(false);
  if (wasHidden) console.log('[launcher] окно показано из трея');
}

// Крестик при включённом трее — спрятать окно (не при выходе и перезапуске).
function onMainWindowClose(e) {
  if (!state.tray || !closeToTrayOn() || state.stopping || state.relaunchRequested || state.restarting) return;
  e.preventDefault();
  state.win.hide();
  console.log('[launcher] окно спрятано в трей — dsh работает дальше');
}

// Агент закончил ответ: пока он отвечает, в чате GUI dsh есть индикатор
// [data-chat-running] (только у открытой в окне сессии; это внутренняя
// деталь интерфейса dsh — если её переименуют, сигнал просто перестанет
// срабатывать). Проверка раз в 2 с; переход «работал → нет» при окне не в
// фокусе (или спрятанном) — системное уведомление (клик — открыть окно),
// точка на значке трея, мигание кнопки на панели задач (под X11; на Wayland
// в GNOME его нет) и, если включён, звук.
const AGENT_POLL_MS = 2000;
let agentRunning = false;
// eslint-disable-next-line no-unused-vars -- только держит ссылку: иначе уведомление (и его click) соберёт GC
let agentNotification = null;

function agentSessionTitle() {
  try {
    const m = /^(.*) — [^—]+$/.exec(state.win.webContents.getTitle()); // «<сессия> — DeepSeek Harness»
    return m ? m[1] : '';
  } catch { return ''; }
}

function notifyAgentFinished() {
  console.log('[launcher] уведомление: агент закончил ответ');
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: tr('Агент закончил ответ', 'The agent has finished'),
    body: agentSessionTitle() || 'DeepSeek Harness',
    icon: path.join(__dirname, '..', 'icon.png'),
  });
  n.on('click', () => showMainWindow());
  n.show();
  agentNotification = n;
}

// Короткий двухнотный сигнал — WebAudio прямо в окне (без внешних программ).
function playAgentSound() {
  console.log('[launcher] звук: агент закончил ответ');
  const js = `(() => { try {
    const c = new AudioContext(); const t = c.currentTime;
    for (const [f, at] of [[660, 0], [880, 0.16]]) {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.18, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
      o.connect(g).connect(c.destination); o.start(t + at); o.stop(t + at + 0.32);
    }
    setTimeout(() => c.close(), 900);
  } catch (e) {} })()`;
  state.win.webContents.executeJavaScript(js, true).catch(() => {});
}

async function pollAgentState() {
  if (!state.win || state.win.isDestroyed() || state.stopping) return;
  try { if (new URL(state.win.webContents.getURL()).origin !== new URL(PLAIN_URL).origin) { agentRunning = false; return; } } catch { return; }
  let running;
  try { running = await state.win.webContents.executeJavaScript("!!document.querySelector('[data-chat-running]')", true); } catch { return; }
  if (running === agentRunning) return;
  agentRunning = running;
  if (running) { console.log('[launcher] агент отвечает'); return; }
  const hidden = !state.win.isVisible();
  const away = hidden || !state.win.isFocused();
  console.log(`[launcher] агент закончил ответ${hidden ? ' — окно в трее' : away ? ' — окно не в фокусе' : ''}`);
  if (!away || !attentionOn()) return;
  notifyAgentFinished();
  if (state.tray) { setTrayAttention(true); console.log('[launcher] значок трея: агент закончил ответ'); }
  if (!hidden) state.win.flashFrame(true);
  if (attentionSoundOn()) playAgentSound();
}

module.exports = { closeToTrayOn, attentionOn, attentionSoundOn, trayMenu, setTray, setTrayAttention, showMainWindow, onMainWindowClose, AGENT_POLL_MS, playAgentSound, pollAgentState };
