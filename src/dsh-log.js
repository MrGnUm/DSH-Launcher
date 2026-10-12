'use strict';
// Окно «Журнал dsh»: последние строки dsh.log, токены скрыты.
const fs = require('fs');
const state = require('./state');
const i18n = require('./i18n');
const { tr } = i18n;
const { esc, redactLog } = require('./util');
const { LOG_FILE } = require('./env');
const launcher = require('./launcher'); // общий реестр (наполняет main.js)

/* ---------------- журнал dsh ---------------- */

// «Справка → Журнал dsh»: хвост dsh.log в окне-диалоге. В логе есть токен
// входа в GUI («dsh web: …?token=…») — его и похожее на ключи при показе и
// копировании заменяем на ***.



// Последние строки файла (читаем только хвост — лог бывает большим).
function logTail(file, maxLines = 300, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // первая строка — обрывок
    return text.split('\n').slice(-maxLines).join('\n').replace(/\s+$/, '');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ } }
}

function showLogDialog() {
  const title = tr('Журнал dsh', 'dsh log');
  const gen = launcher.openDialog(title);
  if (gen === null) return;
  const render = (copied) => {
    const raw = logTail(LOG_FILE);
    const text = raw === null ? null : redactLog(raw);
    state.dialogCopyText = text || '';
    const body = `
      <p style="margin:0 0 8px"><code>${esc(LOG_FILE)}</code> — ${tr('последние строки; токены и ключи скрыты (***)', 'latest lines; tokens and keys are hidden (***)')}</p>
      ${text === null
        ? `<p>${tr('Журнала ещё нет — dsh не запускался лаунчером.', 'No log yet — dsh has not been started by the launcher.')}</p>`
        : `<pre class="log">${esc(text || '…')}</pre>`}
      <div class="actions">
        <button onclick="location.href='dshlauncher://dialog/log-refresh/'">${tr('Обновить', 'Refresh')}</button>
        ${text ? '<button onclick="location.href=\'dshlauncher://dialog/copy/\'">' + (copied ? tr('Скопировано', 'Copied') : tr('Скопировать', 'Copy')) + '</button>' : ''}
        <button onclick="location.href='dshlauncher://dialog/logs/'">${tr('Папка логов', 'Logs folder')}</button>
        ${launcher.dialogCloseButton()}
      </div>
      <script>const l = document.querySelector('pre.log'); if (l) l.scrollTop = l.scrollHeight;</script>`;
    launcher.dialogPage(title, body);
  };
  launcher.dialogShow(gen, render);
}

module.exports = { logTail, showLogDialog };
