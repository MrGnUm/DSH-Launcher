'use strict';
// Журналы: launcher.log (всё, что лаунчер пишет в консоль, — со временем,
// без строк dsh, токены скрыты) и dsh.log (вывод dsh); ротация после
// MAX_LOG_BYTES — при открытии и во время работы.
const fs = require('fs');
const util = require('util');
const { LOG_DIR, LAUNCHER_LOG_FILE, MAX_LOG_BYTES } = require('./env');
const { redactLog } = require('./util');

// Ротация при открытии: файл больше MAX_LOG_BYTES — сдвигаем в <файл>.1.
function rotateLog(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_LOG_BYTES) return null;
    fs.renameSync(file, file + '.1');
    return st.size;
  } catch { return null; } // файла ещё нет — ротировать нечего
}

// Журнал лаунчера (launcher.log): всё, что лаунчер выводит в консоль, — с
// временем; при запуске с ярлыка консоль никуда не пишется. Строки «[dsh] …»
// не дублируем — они в dsh.log. Токены скрыты (redactLog). Пишем синхронно:
// строк немного, а при сбое последние не потеряются.
function startLauncherLog() {
  const rotated = rotateLog(LAUNCHER_LOG_FILE);
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* noop */ }
  let ok = true;
  let size = 0;
  try { size = fs.statSync(LAUNCHER_LOG_FILE).size; } catch { /* нового ещё нет */ }
  const write = (text) => {
    if (!ok) return;
    try {
      // и во время работы (лаунчер может быть открыт неделями) — до записи,
      // чтобы текущий файл всегда был
      const n = Buffer.byteLength(text);
      if (size > 0 && size + n > MAX_LOG_BYTES) { fs.renameSync(LAUNCHER_LOG_FILE, LAUNCHER_LOG_FILE + '.1'); size = 0; }
      fs.appendFileSync(LAUNCHER_LOG_FILE, text);
      size += n;
    } catch { ok = false; } // нет доступа — журнал без файла, лаунчер работает
  };
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const text = util.format(...args);
      if (text.startsWith('[dsh]')) return;
      const d = new Date();
      const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 23); // местное время
      write(redactLog(text).split('\n').map((l) => `${t} ${l}`).join('\n') + '\n');
    };
  }
  let version = '?';
  try { version = require('../package.json').version; } catch { /* noop */ }
  write(`\n===== DeepSeek Harness Launcher ${version}, pid ${process.pid}, ${new Date().toISOString()} =====\n`);
  if (rotated) console.log(`[launcher] лог прокручен: launcher.log (${rotated} Б) -> launcher.log.1`);
}
// Журнал dsh с ротацией и во время работы (dsh бывает разговорчив, а лаунчер
// открыт неделями): строка не помещается в MAX_LOG_BYTES — файл сдвигается в
// <файл>.1, строка пишется в новый. Синхронно, через дескриптор: у потока
// (createWriteStream) файл открывается позже, и после переименования поток
// писал бы снова в новый файл.
function openDshLog(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* файла ещё нет */ }
  let fd = null;
  try { fd = fs.openSync(file, 'a'); } catch (e) { console.error('[launcher] dsh.log:', e.message); }
  return {
    write(text) {
      if (fd === null) return;
      try {
        const n = Buffer.byteLength(text);
        if (size > 0 && size + n > MAX_LOG_BYTES) {
          fs.closeSync(fd);
          fd = null;
          fs.renameSync(file, file + '.1');
          fd = fs.openSync(file, 'a');
          size = 0;
        }
        fs.writeSync(fd, text);
        size += n;
      } catch (e) {
        console.error('[launcher] dsh.log:', e.message);
      }
    },
    end() {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* noop */ } fd = null; }
    },
  };
}

module.exports = { rotateLog, startLauncherLog, openDshLog };
