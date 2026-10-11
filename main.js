'use strict';

/*
 * dsh-launcher — окно, которое ведёт процесс DeepSeek Harness.
 *
 *  - если порт 3080 не слушается, запускает `dsh --profile web --no-open`;
 *  - строку `dsh web: http://127.0.0.1:3080/?token=...`, которую dsh печатает
 *    в stdout, подхватывает и открывает в окне — так выдаётся сессийный куки,
 *    который запоминается в профиле приложения;
 *  - если dsh уже запущен (например, из терминала), подключается к нему и НЕ
 *    убивает его при закрытии; если валидного куки нет, просит вставить URL
 *    с токеном из терминала, где работает dsh;
 *  - закрытие окна завершает всё дерево процессов dsh, которое запустил лаунчер
 *    (и dsh, «усыновлённый» после самовозрождения — он ищется по порту):
 *    сначала SIGTERM, через 4 с — SIGKILL;
 *  - SIGTERM/SIGINT/SIGHUP самому лаунчеру: штатное закрытие (как закрытие окна);
 *    повторный сигнал или зависание дольше 8 с — SIGKILL дереву dsh. Прямой
 *    SIGKILL лаунчеру перехватить нельзя — тот случай остаётся незакрытым.
 */

const { app, BrowserWindow, WebContentsView, Menu, Tray, Notification, nativeImage, protocol, net: electronNet, session, screen, dialog, shell, clipboard } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const util = require('util');
const { promisify } = util;
const nodeNet = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
const state = require('./src/state'); // общее состояние (окно, процесс dsh, флаги)
const i18n = require('./src/i18n');
const { tr } = i18n;
const { splitArgs, firstErrLine, esc, profileFromArgs, timedCheck, launcherRoute, redactLog } = require('./src/util');
const { envWithBinDir, writableOrCreatable, groupAlive, portListenerPid, pgidOf, pickKillTargets } = require('./src/system');
const { compareDebianVer, compareSemVer, tagToPackageVersion, updateStatus, dpkgStatusVersion, shouldShowWhatsNew, notesBetween } = require('./src/versions');
const { releaseNotesLang, mdToHtml } = require('./src/notes');
const { DEFAULT_PORT, DEFAULT_PROFILE, effectiveConfig, settingValue, restartNeeded } = require('./src/config');
const { releasesCacheMode, releasesCacheFresh, updatePollMs, announceUpdates, proxyUrlFromRule } = require('./src/updates-logic');
const { WIN_DEFAULT, WIN_MIN, contextMenuItems, keyAction, windowSize, gpuStatus, reportFileName, reportInfoText } = require('./src/ui');

// Параметры запуска и журнал лаунчера — первыми: env.js убирает токен CI из
// окружения, log.js начинает писать launcher.log.
const {
  GITHUB_TOKEN, UPDATE_NOW, SETTINGS_FILE, loadSettings, CONFIG, DSH_BIN_DEFAULT, DSH_BIN_EXPLICIT, DSH_ARGS, CWD,
  HOST, PORT, PLAIN_URL, START_TIMEOUT, LOG_DIR, LOG_FILE, LAUNCHER_LOG_FILE, MAX_LOG_BYTES, LANG_FORCED,
} = require('./src/env');
const { rotateLog, startLauncherLog, openDshLog } = require('./src/log');
startLauncherLog();

// путь к dsh задан явно (переменная DSH_BIN или «Настройки»); иначе, если
// /usr/bin/dsh нет, — ищется в PATH, npm prefix, nvm и т.п. (см. findDsh),
// найденный путь запоминается
state.dshBin = CONFIG.dshBin || DSH_BIN_DEFAULT;

let UI_LANG = LANG_FORCED || (/^ru/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '') ? 'ru' : 'en');
i18n.setLang(UI_LANG);

/* ============================================================== */

app.setName('dsh-launcher');

// Диагностика сессии в лог — первое, что смотреть, если «окно не появляется».
if (process.platform === 'linux') {
  console.log(
    `[launcher] сессия: XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE || '(пусто)'} ` +
    `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY || '(пусто)'} DISPLAY=${process.env.DISPLAY || '(пусто)'}`
  );
}

// Есть ли в системе реальный GPU (render-узлы /dev/dri/renderD*).
// ВМ/VNC без 3D-ускорения их не имеют.
const hasGpuRenderNode = (() => {
  try { return fs.readdirSync('/dev/dri').some((f) => /^renderD/.test(f)); }
  catch { return false; }
})();

// Окно на Wayland предъявляется через EGL. Если у GPU виртуалки нет рабочего
// драйвера (ANGLE/EGL-ошибки в логе), окно «показано» по логам Electron, но на
// экране его не видно. X11/XWayland-путь деградирует до программного рендера —
// окно остаётся видимым. На X11-сессиях ничего не меняем.
// Если реальный GPU есть (renderD* в /dev/dri) — не форсим X11: нативный
// Wayland работает, а X11/XWayland-окно на KWin остаётся невидимым. Ручной
// переключатель: DSH_LAUNCHER_OZONE=x11|wayland.
const isWaylandSession = process.platform === 'linux' &&
  (String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
   Boolean(process.env.WAYLAND_DISPLAY));
if (isWaylandSession) {
  // Ошибку в значении DSH_LAUNCHER_OZONE не передаём в Electron:
  // неизвестный ozone-platform может не инициализироваться вовсе.
  const ozoneManual = CONFIG.ozone !== 'auto'; // DSH_LAUNCHER_OZONE или «Настройки»
  const ozone = ozoneManual ? CONFIG.ozone : hasGpuRenderNode ? 'wayland' : 'x11';
  app.commandLine.appendSwitch('ozone-platform', ozone);
  console.log(
    `[launcher] Wayland-сессия — ozone-platform=${ozone}` +
    (ozoneManual
      ? (CONFIG.src.ozone === 'env' ? ' (принудительно: DSH_LAUNCHER_OZONE)' : ' (выбрано в «Настройках»)')
      : hasGpuRenderNode
        ? ' (есть реальный GPU — нативный Wayland; X11/XWayland-окно на KWin невидимо)'
        : ' (render-узлов нет — окно веду через X11 (XWayland))')
  );
}

// ВМ/VNC без 3D-ускорения: render-узлов нет, EGL гарантированно не поднимется —
// идём сразу в программный рендер, минуя цикл падений GPU-процесса (ANGLE/EGL
// ошибки в логе). То же, если библиотек EGL в системе нет вовсе. Ручной
// переключатель: DSH_LAUNCHER_NO_GPU=1.
const hasEglLibs = (() => {
  try {
    const out = execFileSync('ldconfig', ['-p'], { encoding: 'utf8', timeout: 2000 });
    return /libEGL\.so\.1/.test(out) && /libGLESv2\.so\.[12]/.test(out);
  } catch { return true; } // не удалось проверить — решение не меняем
})();

// Маркер «GPU-драйвер сломан». Сломанный драйвер (SIGSEGV в GPU-процессе) на
// старте надёжно не определяется — но падение видно в рантайме. Запоминаем его
// в файл: следующие запуски сразу идут в программный рендер. Маркер живёт 30
// дней (на случай, если драйвер починили); чтобы вернуть GPU раньше — удалить
// файл.
const GPU_MARKER_FILE = path.join(LOG_DIR, 'gpu-disabled.marker');
const GPU_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const gpuMarkerAgeMs = (() => {
  try { return Date.now() - fs.statSync(GPU_MARKER_FILE).mtimeMs; }
  catch { return null; }
})();
const gpuDisabledByMarker = process.platform === 'linux' &&
  gpuMarkerAgeMs !== null && gpuMarkerAgeMs < GPU_MARKER_TTL_MS;

const noGpuRequested = CONFIG.noGpu; // DSH_LAUNCHER_NO_GPU=1 или «Настройки» → «Выключено»
if (process.platform === 'linux' && (noGpuRequested || gpuDisabledByMarker || !hasGpuRenderNode || !hasEglLibs)) {
  app.disableHardwareAcceleration();
  const why = noGpuRequested ? (CONFIG.src.gpu === 'env' ? 'DSH_LAUNCHER_NO_GPU=1' : '«Настройки»: GPU-ускорение — выключено')
    : gpuDisabledByMarker ? `маркер ${GPU_MARKER_FILE} (GPU-процесс падал, маркер живёт 30 дней; удалить файл, чтобы включить GPU)`
    : !hasGpuRenderNode ? 'render-узлов в /dev/dri нет'
    : 'EGL-библиотек (libEGL/libGLESv2) в системе нет';
  console.log(`[launcher] ${why} — отключаю GPU-ускорение (программный рендер)`);
}

// Две и более смерти GPU-процесса за сессию = драйвер сломан: пишем маркер,
// чтобы следующие запуски сразу обходили GPU.
let gpuCrashCount = 0;
app.on('child-process-gone', (_event, details) => {
  if (launcherUpdatedOnDisk) {
    console.log(`[launcher] процесс ${details.type} завершился после обновления на диске — перезапускаюсь`);
    restartLauncher();
    return;
  }
  if (details.type !== 'GPU' || (details.reason !== 'crashed' && details.reason !== 'abnormal-exit')) return;
  gpuCrashCount += 1;
  console.log(`[launcher] GPU-процесс завершился (reason=${details.reason}, code=${details.exitCode}, #${gpuCrashCount})`);
  if (gpuCrashCount === 2 && !gpuDisabledByMarker) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(GPU_MARKER_FILE, `GPU process crashed x2, reason=${details.reason}, ${new Date().toISOString()}\n`);
      console.log(`[launcher] GPU-драйвер, похоже, сломан — следующий запуск пойдёт в программном рендере (маркер ${GPU_MARKER_FILE})`);
    } catch (e) {
      console.log('[launcher] не удалось записать GPU-маркер:', e.message);
    }
  }
});

state.win = null;
state.dshProc = null;
state.weStartedDsh = false;
state.adoptedDsh = false; // dsh «усыновлён» после самовозрождения — тоже останавливаем при закрытии
state.adoptedOldPgid = null; // группа исходного dsh до самовозрождения (могли остаться потомки)
state.dshFatal = false;
state.stopping = false;
state.authUrl = null; // URL с токеном, напечатанный dsh
const stderrTail = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pushErr(line) {
  const t = line.trim();
  if (!t) return;
  stderrTail.push(t);
  if (stderrTail.length > 300) stderrTail.shift();
  console.error('[dsh]', t);
}

function portOpen() {
  return new Promise((resolve) => {
    const s = new nodeNet.Socket();
    const done = (ok) => {
      try { s.destroy(); } catch { /* noop */ }
      resolve(ok);
    };
    s.setTimeout(800);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(PORT, HOST);
  });
}

async function waitForPort() {
  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    if (await portOpen()) return true;
    if (state.dshProc && (state.dshProc.exitCode !== null || state.dshFatal)) return false;
    await sleep(400);
  }
  return portOpen();
}

async function waitForAuthUrl(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!state.authUrl && Date.now() < deadline) await sleep(100);
  return state.authUrl;
}

/* ---------------- проверка установки dsh ---------------- */

// Окружение для запуска dsh: каталог бинарника — первым в PATH. dsh — это
// `#!/usr/bin/env node`-скрипт; установленный через nvm, он должен получить
// node из того же каталога, а при запуске с ярлыка nvm в PATH нет.
function dshEnv(extra) {
  return envWithBinDir(state.dshBin, extra);
}



async function probeDsh(bin) {
  if (!bin || !fs.existsSync(bin)) return { ok: false, reason: 'missing' };
  try {
    const { stdout: out } = await execFileAsync(bin, ['--version'], { encoding: 'utf8', timeout: 8000, env: envWithBinDir(bin) });
    return { ok: true, version: (out.trim().split('\n').pop() || '').trim() };
  } catch (e) {
    const detail = firstErrLine(e.stderr || e.message);
    return { ok: false, reason: 'broken', detail };
  }
}

const dshBinPrefFile = () => path.join(app.getPath('userData'), 'dsh-bin.json');

// bin-каталоги всех версий node из nvm, свежие первыми.
function nvmBinDirs() {
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  try {
    return fs.readdirSync(path.join(nvmDir, 'versions', 'node'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(nvmDir, 'versions', 'node', v, 'bin'));
  } catch { return []; } // nvm нет
}

// Окружение с каталогом бинарника первым в PATH (для `#!/usr/bin/env node`-скриптов).


// Исполняемый файл: рядом с dsh, в PATH, иначе в nvm (при запуске с ярлыка
// nvm в PATH нет).
function findBin(name) {
  const dirs = [path.dirname(state.dshBin)]
    .concat(String(process.env.PATH || '').split(path.delimiter).filter(Boolean), nvmBinDirs());
  for (const dir of dirs) {
    const bin = path.join(dir, name);
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch { /* дальше */ }
  }
  return null;
}
const findNpm = () => findBin('npm');

// Где искать dsh, если DSH_BIN не задан: запомненный путь, /usr/bin/dsh,
// PATH, типичные каталоги пользовательских npm-установок, все версии nvm
// (свежие первыми). npm prefix -g — последним, он медленный.
function dshCandidates() {
  const home = os.homedir();
  const list = [];
  try { list.push(JSON.parse(fs.readFileSync(dshBinPrefFile(), 'utf8')).bin); } catch { /* не запоминали */ }
  list.push(DSH_BIN_DEFAULT);
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) if (dir) list.push(path.join(dir, 'dsh'));
  list.push(path.join(home, '.npm-global', 'bin', 'dsh'), path.join(home, '.local', 'bin', 'dsh'), '/usr/local/bin/dsh');
  for (const dir of nvmBinDirs()) list.push(path.join(dir, 'dsh'));
  return [...new Set(list.filter(Boolean))];
}

// Проверяем не только наличие файла, но и что бинарник реально запускается:
// битый symlink, несовместимый Node или отсутствующий npm дадут ошибку здесь,
// а не загадочным ENOENT в момент старта. dsh --version занимает ~60 мс.
// Асинхронно: при медленной системе синхронный вызов замораживал бы окно.
// Если DSH_BIN не задан явно — перебираем кандидатов (dshCandidates) и
// переключаем DSH_BIN на первый рабочий, запоминая его в userData/dsh-bin.json.
async function dshInstallCheck() {
  if (DSH_BIN_EXPLICIT) return probeDsh(state.dshBin);
  let firstBroken = null;
  const tryBin = async (bin) => {
    const r = await probeDsh(bin);
    if (r.ok) {
      if (bin !== state.dshBin) console.log(`[launcher] dsh найден: ${bin} (${r.version})`);
      state.dshBin = bin;
      try {
        fs.mkdirSync(path.dirname(dshBinPrefFile()), { recursive: true });
        fs.writeFileSync(dshBinPrefFile(), JSON.stringify({ bin }));
      } catch (e) { console.error('[launcher] dsh-bin.json:', e.message); }
    } else if (r.reason === 'broken' && !firstBroken) {
      firstBroken = { ...r, bin };
    }
    return r.ok ? r : null;
  };
  for (const bin of dshCandidates()) {
    const r = await tryBin(bin);
    if (r) return r;
  }
  const npm = findNpm();
  if (npm) {
    try {
      const prefix = (await execFileAsync(npm, ['prefix', '-g'], { encoding: 'utf8', timeout: 10000, env: envWithBinDir(npm) })).stdout.trim();
      const r = await tryBin(path.join(prefix, 'bin', 'dsh'));
      if (r) return r;
    } catch { /* npm не отвечает */ }
  }
  if (firstBroken) {
    state.dshBin = firstBroken.bin; // показываем на странице тот, что сломан
    return { ok: false, reason: 'broken', detail: firstBroken.detail };
  }
  state.dshBin = DSH_BIN_DEFAULT;
  return { ok: false, reason: 'missing' };
}

// Есть ли npm и доступен ли глобальный prefix без sudo — от этого зависит,
// можно ли ставить dsh кнопкой прямо из окна.
const INSTALL_CMD = 'npm install -g @deepseek-ai/dsh';
// Право записи проверяем у ближайшего существующего каталога: на чистой
// системе <prefix>/lib/node_modules ещё нет (появится при первой глобальной
// установке), и ENOENT от него раньше ошибочно означал «npm нет».


// dsh нужен Node.js 22+. npm ставит его и на более старый Node без единого
// предупреждения (Ubuntu 24.04: Node 18 из apt), а потом dsh не запускается.
const MIN_NODE_MAJOR = 22;

async function nodeVersionNear(npm) {
  try {
    const { stdout } = await execFileAsync('node', ['--version'], { encoding: 'utf8', timeout: 5000, env: envWithBinDir(npm) });
    return stdout.trim();
  } catch { return null; }
}

async function npmInstallInfo() {
  const npm = findNpm();
  if (!npm) return { hasNpm: false, canAuto: false, command: INSTALL_CMD };
  const nodeVersion = await nodeVersionNear(npm);
  const major = Number((/^v(\d+)/.exec(nodeVersion || '') || [])[1]);
  const nodeOld = Number.isFinite(major) && major < MIN_NODE_MAJOR;
  try {
    const prefix = (await execFileAsync(npm, ['prefix', '-g'], { encoding: 'utf8', timeout: 10000, env: envWithBinDir(npm) })).stdout.trim();
    const writable = writableOrCreatable(path.join(prefix, 'lib', 'node_modules')) &&
      writableOrCreatable(path.join(prefix, 'bin'));
    return { hasNpm: true, canAuto: writable && !nodeOld, nodeVersion, nodeOld, npm, prefix,
      command: writable ? INSTALL_CMD : 'sudo ' + INSTALL_CMD };
  } catch (e) {
    console.error('[launcher] npm prefix -g:', e.message);
    return { hasNpm: true, canAuto: false, nodeVersion, nodeOld, npm, command: 'sudo ' + INSTALL_CMD };
  }
}

/* ---------------- запуск процесса dsh ---------------- */

// Chromium держит часть своих дескрипторов (разделяемая память, сокеты,
// icudtl.dat, порт отладки…) без «закрыть при exec» — дочерний процесс
// получал бы их все. Поэтому долгоживущие процессы (dsh, новый экземпляр
// лаунчера) запускаются через bash, который закрывает всё, кроме 0–2, и
// делает exec (pid — тот же). bash, а не sh: dash не закрывает дескрипторы с
// номером больше 9.
const CLOSE_INHERITED_FDS = 'for f in /proc/$$/fd/*; do n=${f##*/}; if [ "$n" -gt 2 ] 2>/dev/null; then eval "exec $n>&-" 2>/dev/null; fi; done; ';

function spawnClean(cmd, args, opts) {
  return spawn('/bin/bash', ['-c', CLOSE_INHERITED_FDS + 'exec "$@"', 'dsh-launcher', cmd, ...args], opts);
}

function startDsh() {
  // dsh.log пишет только startDsh (stdout dsh) — ротируем перед открытием потока.
  const rotated = rotateLog(LOG_FILE);
  if (rotated) console.log(`[launcher] лог прокручен: dsh.log (${rotated} Б) -> dsh.log.1`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logStream = openDshLog(LOG_FILE);
  state.authUrl = null; // токен прошлого процесса недействителен — ждём новый
  console.log(`[launcher] starting: ${state.dshBin} ${DSH_ARGS.join(' ')} (cwd=${CWD}, log=${LOG_FILE})`);
  const opts = {
    cwd: CWD,
    env: dshEnv({ DSH_STARTED_BY: 'dsh-launcher' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // dsh становится лидером своей процесс-группы — можно убить всё дерево
  };
  // Через bash (spawnClean) ошибку «нет такой программы» spawn не вернёт —
  // такую (и команду без пути, из PATH) запускаем напрямую: 'error' как раньше.
  let direct = false;
  try { fs.accessSync(state.dshBin, fs.constants.X_OK); } catch { direct = true; }
  state.dshProc = direct || !path.isAbsolute(state.dshBin) ? spawn(state.dshBin, DSH_ARGS, opts) : spawnClean(state.dshBin, DSH_ARGS, opts);
  state.weStartedDsh = true;
  state.adoptedDsh = false; // снова собственный процесс — «усыновлённого» больше нет
  state.adoptedOldPgid = null;
  state.dshFatal = false;
  state.dshProc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      console.log('[dsh]', line.trim());
      logStream.write(line + '\n');
      const m = /dsh web:\s*(https?:\/\/\S+)/.exec(line) ||
                /(https?:\/\/[^\s]*\?token=[^\s&]+)/.exec(line);
      if (m) {
        console.log('[launcher] captured auth URL');
        state.authUrl = m[1];
      }
    }
  });
  state.dshProc.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      pushErr(line);
      logStream.write(line + '\n');
    }
  });
  state.dshProc.on('error', (err) => {
    state.dshFatal = true;
    pushErr(tr(`ошибка запуска dsh: ${err.message}`, `failed to start dsh: ${err.message}`));
  });
  const proc = state.dshProc;
  state.dshProc.on('exit', (code, signal) => {
    try { logStream.end(); } catch { /* noop */ }
    if (proc !== state.dshProc || restartingDsh) { // остановлен «Перезапустить dsh» — это не сбой
      console.log('[launcher] прежний процесс dsh завершился (перезапуск):', { code, signal });
      return;
    }
    handleDshExit(code, signal);
  });
}

/* ---------------- остановка дерева процессов ---------------- */

// groupOnly: главный процесс уже завершился — его pid мог занять чужой
// процесс, поэтому без запасного варианта «просто pid», только группа (-pid).
function killGroup(pid, signal, groupOnly = false) {
  try { process.kill(-pid, signal); } catch {
    if (groupOnly) return;
    try { process.kill(pid, signal); } catch { /* noop */ }
  }
}



// Главный процесс dsh завершился (по коду или по сигналу).
function dshLeaderExited() {
  return state.dshProc.exitCode !== null || state.dshProc.signalCode !== null;
}

async function stopDsh() {
  if (!state.weStartedDsh || !state.dshProc || state.dshProc.pid === undefined) return;
  const pid = state.dshProc.pid;
  if (state.dshFatal) return; // spawn не удался — процесса не было
  const groupOnly = dshLeaderExited();
  if (!groupAlive(pid, groupOnly)) return; // группа уже мёртва — нечего убивать
  killGroup(pid, 'SIGTERM', groupOnly);
  for (let i = 0; i < 40 && groupAlive(pid, groupOnly); i++) await sleep(100); // до 4 с
  if (groupAlive(pid, groupOnly)) {
    killGroup(pid, 'SIGKILL');
    for (let i = 0; i < 20 && groupAlive(pid); i++) await sleep(100);
  }
  console.log('[launcher] dsh stopped by launcher');
}

// pid процесса, слушающего порт (Linux, чистый fs — без fuser/ss):
// inode сокетов LISTEN берём из /proc/net/tcp{,6}, затем ищем fd
// socket:[inode] среди /proc/[pid]/fd/*.


// pgid процесса: поле 5 из /proc/<pid>/stat (comm в скобках может содержать
// пробелы — считаем от последней «)»).


// Что убивать у «усыновлённого» dsh (после самовозрождения). Ручки на новый
// процесс у нас нет, поэтому:
//  - процесс на порту: убиваем его группу по pgid — он может быть не лидером
//    группы, и тогда kill(-pid) не сработал бы, а потомки остались бы жить;
//  - группа исходного dsh: в ней могли остаться его потомки (лидер мёртв —
//    только группа, без запасного варианта по pid).


function adoptedTargets() {
  const pid = portListenerPid(PORT);
  return pickKillTargets(pid, pid ? pgidOf(pid) : null, pgidOf(process.pid), state.adoptedOldPgid);
}

async function stopAdoptedDsh() {
  const targets = adoptedTargets().filter((t) => groupAlive(t.id, t.groupOnly));
  if (targets.length === 0) {
    console.log('[launcher] усыновлённый dsh: живых процессов не найдено — не убиваем (порт уже закрыт?)');
    return;
  }
  console.log(`[launcher] останавливаю усыновлённый dsh (${targets.map((t) => (t.groupOnly ? 'pgid=' : 'pid=') + t.id).join(', ')})`);
  const alive = () => targets.filter((t) => groupAlive(t.id, t.groupOnly));
  for (const t of targets) killGroup(t.id, 'SIGTERM', t.groupOnly);
  for (let i = 0; i < 20 && alive().length; i++) await sleep(100); // до 2 с
  for (const t of alive()) killGroup(t.id, 'SIGKILL', t.groupOnly);
}

/* ---------------- самовозрождение dsh (self-restart) ----------------
 * Менеджер плагинов dsh перезапускает сам процесс (после обновления плагина
 * уведомляет «изменения вступят в силу при следующем старте», и при
 * подтверждении дш поднимает новый процесс, а старый спокойно выходит с
 * code=0). Порт при этом может не закрываться вовсе (новый процесс
 * подхватывает его до выхода старого) — watchdog такой переход не видит.
 * Поэтому по exit нашего дочернего процесса проверяем порт: если он жив
 * или оживает — не показываем ошибку, а «усыновляем» запущенный dsh
 * (дальше работаем с ним как с подключением, но при закрытии окна всё
 * равно останавливаем — pid ищется по порту) и обновляем окно. Куки при
 * этом живы — секрет подписи хранится в ~/.dsh/.credentials.yaml и
 * переживает перезапуск.
 */
let adoptionCheck = false;

async function handleDshExit(code, signal) {
  console.log('[launcher] dsh process exited:', { code, signal });
  if (state.stopping) return;
  pushErr(tr(`dsh остановился (code=${code}, signal=${signal})`, `dsh stopped (code=${code}, signal=${signal})`));
  if (adoptionCheck) return; // на всякий случай: один цикл проверки
  adoptionCheck = true;
  try {
    showPage(() => showStatus(tr('dsh перезапускается…', 'dsh is restarting…'), tr(
      `<p>Процесс <code>dsh</code> завершился (code=${code}).<br>
         Проверяю, не запустился ли новый процесс…</p>`,
      `<p>The <code>dsh</code> process exited (code=${code}).<br>
         Checking whether a new process has started…</p>`), false));
    const deadline = Date.now() + 8000;
    let up = await portOpen();
    while (!up && Date.now() < deadline) { await sleep(500); up = await portOpen(); }
    if (up && !state.stopping && state.win && !state.win.isDestroyed()) {
      console.log('[launcher] порт снова открыт — dsh перезапустился сам, перехожу в режим подключения');
      state.weStartedDsh = false; // новый процесс — не наш дочерний (ручки на него нет)
      state.adoptedDsh = true;    // но это тот же dsh сессии — при закрытии окна остановим
      if (state.dshProc && state.dshProc.pid !== undefined) state.adoptedOldPgid = state.dshProc.pid;
      state.dshProc = null;
      state.dshFatal = false;
      state.portState = 'up';     // синхронизация со watchdog — не давать лишней перезагрузки
      await recoverWindow(true);
      return;
    }
  } finally {
    adoptionCheck = false;
  }
  if (state.win && !state.win.isDestroyed() && !state.stopping) {
    showPage(() => showStatus(tr('dsh остановился', 'dsh has stopped'), tr(
      `<p>Процесс DeepSeek Harness завершился, и за 8 секунд новый процесс
         не запустился.</p>`,
      `<p>The DeepSeek Harness process exited, and no new process started
         within 8 seconds.</p>`) + retryButton() + stderrBlock(), true));
  }
}

/* ===== retryButton (тест test/pages.js) ===== */
function retryButton() {
  return `<button onclick="location.href='dshlauncher://retry/'" style="margin-bottom:16px">${tr('Проверить снова', 'Check again')}</button>`;
}
/* ===== end retryButton ===== */

/* ---------------- страницы-статусы ---------------- */



const PAGE_CSS = `
  html,body{margin:0;height:100%;background:#0f1115;color:#d7dce3;
    font-family:system-ui,'Segoe UI',Roboto,Ubuntu,sans-serif}
  .wrap{max-width:700px;margin:0 auto;padding:12vh 24px 24px}
  h1{font-size:20px;font-weight:600;margin:0 0 14px}
  p{line-height:1.6;color:#9aa4b2;margin:0 0 12px}
  code{background:#1a2130;padding:2px 6px;border-radius:6px;font-size:0.9em;color:#c7d2fe}
  pre{background:#151a23;border:1px solid #232b3a;border-radius:10px;padding:12px 14px;
    font-size:12px;line-height:1.5;overflow:auto;max-height:34vh;white-space:pre-wrap;
    word-break:break-word;color:#c7cedb}
  input:not([type=checkbox]):not([type=radio]){width:100%;box-sizing:border-box;background:#151a23;
    border:1px solid #2a3550;border-radius:10px;color:#e6ebf4;padding:12px 14px;font-size:14px;margin-bottom:12px}
  input:focus{outline:none;border-color:#3b82f6}
  button{background:#3b82f6;border:0;border-radius:10px;color:#fff;padding:12px 22px;
    font-size:14px;cursor:pointer}
  button:hover{background:#2f6fd8}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:9px}
  .err .dot{background:#f85149}
  .lang{position:fixed;top:14px;right:18px;font-size:13px;color:#4b5567;user-select:none}
  .lang a{color:#6b7689;text-decoration:none;padding:2px 4px;border-radius:5px}
  .lang a:hover{color:#d7dce3}
  .lang a.on{color:#d7dce3;font-weight:600;pointer-events:none}
  ::-webkit-scrollbar{width:8px;height:8px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:#2a3550;border-radius:8px;border:2px solid transparent;background-clip:padding-box}
  ::-webkit-scrollbar-thumb:hover{background:#3b4a6b;background-clip:padding-box}
  ::-webkit-scrollbar-corner{background:transparent}
  .notes{max-height:34vh;overflow:auto;background:#151a23;border:1px solid #232b3a;border-radius:10px;
    padding:4px 16px 8px;margin-bottom:14px}
  .notes .ver{margin:12px 0 2px}
  .notes h4{margin:10px 0 4px;font-size:13px;color:#9aa4b2;font-weight:600}
  .notes ul{margin:4px 0 8px;padding-left:20px}
  .notes li{line-height:1.5;color:#c7cedb;margin:3px 0}
  .notes p{margin:4px 0 8px}
  .notes a{color:#7aa2f7}
  .dlg .wrap{max-width:none;padding:20px 24px;height:100%;box-sizing:border-box;
    display:flex;flex-direction:column}
  .dlg .notes{flex:1 1 auto;max-height:none;min-height:80px;margin-bottom:0}
  .dlg pre.log{flex:1 1 auto;max-height:none;min-height:80px;margin:0;white-space:pre-wrap}
  .dlg .form{flex:1 1 auto;overflow:auto;min-height:0;padding-right:6px}
  .dlg .form h4{margin:14px 0 6px;font-size:13px;color:#d7dce3;font-weight:600}
  .dlg .form h4:first-child{margin-top:0}
  .dlg .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0;color:#9aa4b2}
  .dlg .row > span:first-child{min-width:150px}
  .dlg .row input:not([type=checkbox]),.dlg .row select{width:auto;margin:0;padding:6px 9px;font-size:13px;
    background:#151a23;border:1px solid #2a3550;border-radius:7px;color:#e6ebf4}
  .dlg .row input:disabled,.dlg .row select:disabled{opacity:.55}
  .dlg .row button{padding:6px 12px;font-size:13px}
  .dlg .row code.val{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dlg .sett{display:flex;gap:22px;align-items:flex-start}
  .dlg .sett nav{display:flex;flex-direction:column;gap:2px;min-width:150px;position:sticky;top:0}
  .dlg .sett nav a{padding:7px 12px;border-radius:8px;color:#9aa4b2;cursor:pointer;text-decoration:none;white-space:nowrap}
  .dlg .sett nav a:hover{background:#151a23;color:#d7dce3}
  .dlg .sett nav a.on{background:#1f2836;color:#e6ebf4;font-weight:600}
  .dlg .sett .panes{flex:1;min-width:0}
  .dlg .sett section[hidden]{display:none}
  .dlg .chk{display:inline-flex;align-items:center;gap:8px;cursor:pointer;line-height:1.4}
  .dlg .chk input{width:16px;height:16px;margin:0;flex:none;accent-color:#3b82f6;cursor:pointer}
  .dlg .hint{font-size:12px;color:#6b7689}
  .dlg .banner{background:#2a2410;border:1px solid #6b5a1e;color:#e5c76b;border-radius:8px;padding:8px 12px;
    margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .dlg .note{margin:0 0 8px;color:#3fb950}
  .dlg .note.err{color:#f85149}
  /* «Сохранено» / ошибка в окне «Настройки» — поверх, в углу над кнопками:
     не сдвигает поля. «Сохранено» гаснет само, ошибка остаётся. */
  .dlg .pop{position:fixed;right:22px;bottom:74px;margin:0;padding:8px 14px;border-radius:9px;z-index:5;
    background:#14251a;border:1px solid #2f6b3d;color:#3fb950;box-shadow:0 6px 20px rgba(0,0,0,.45);
    pointer-events:none;animation:popfade 2.6s ease forwards}
  .dlg .pop.err{background:#2a1517;border-color:#7f2a2a;color:#f85149;animation:popin .15s ease}
  @keyframes popfade{0%{opacity:0;transform:translateY(6px)}8%{opacity:1;transform:none}75%{opacity:1}100%{opacity:0}}
  @keyframes popin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .dlg .actions{margin-top:auto;padding-top:14px;display:flex;gap:10px;flex-wrap:wrap}
  .dlg h1{font-size:18px}
  .dlg button{padding:9px 18px}
`;

/* ===== pageHtml (чистая функция, тест test/pages.js) ===== */
// opts.dialog — для окна-диалога: без переключателя языка, компактно.
function pageHtml(title, body, isError, opts = {}) {
  const langLink = (code, label) =>
    `<a href="dshlauncher://lang/${code}/"${UI_LANG === code ? ' class="on"' : ''}>${label}</a>`;
  const langSwitch = opts.dialog ? '' : `<div class="lang">${langLink('ru', 'RU')} | ${langLink('en', 'EN')}</div>`;
  const html = `<!doctype html><html lang="${UI_LANG}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body${opts.dialog ? ' class="dlg"' : ''}>${langSwitch}<div class="wrap${isError ? ' err' : ''}"><h1><span class="dot"></span>${esc(title)}</h1>${body}</div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}
/* ===== end pageHtml ===== */

function stderrBlock() {
  return `<pre>${esc(stderrTail.slice(-50).join('\n') || tr('нет данных журнала', 'no log data'))}</pre>`;
}

// Текущая служебная страница как функция отрисовки: переключатель RU | EN
// перерисовывает её на новом языке. Каждая show*-страница регистрирует себя
// сама; разовые showStatus оборачиваются в showPage.
state.currentPage = null;

function showPage(render) {
  state.currentPage = render;
  render();
}

const langPrefFile = () => path.join(app.getPath('userData'), 'ui-lang.json');

function loadLangPref() {
  if (LANG_FORCED) return;
  try {
    const v = JSON.parse(fs.readFileSync(langPrefFile(), 'utf8')).lang;
    if (v === 'ru' || v === 'en') { UI_LANG = v; i18n.setLang(UI_LANG); }
  } catch { /* выбора ещё не было — остаётся язык локали */ }
}

function onLangSwitch(lang) {
  if ((lang === 'ru' || lang === 'en') && lang !== UI_LANG) {
    UI_LANG = lang; i18n.setLang(UI_LANG);
    try {
      fs.mkdirSync(path.dirname(langPrefFile()), { recursive: true });
      fs.writeFileSync(langPrefFile(), JSON.stringify({ lang }));
    } catch (e) { console.error('[launcher] ui-lang.json:', e.message); }
    console.log(`[launcher] язык окна: ${lang}`);
  }
  buildAppMenu(); // подписи меню на новом языке
  if (state.currentPage) state.currentPage();
  return blankResponse();
}

// Загрузка в окно. ERR_ABORTED (-3) — не ошибка: эту навигацию сменила
// более новая (статус-страница, watchdog), окно уже показывает её.
async function loadInWin(url) {
  if (!state.win || state.win.isDestroyed()) return;
  try {
    await state.win.loadURL(url);
  } catch (e) {
    if (e.code === 'ERR_ABORTED' || e.errno === -3) {
      console.log(`[launcher] загрузка ${String(url).slice(0, 40)}… прервана более новой навигацией`);
    } else {
      throw e;
    }
  }
}

function showStatus(title, body, isError) {
  loadInWin(pageHtml(title, body, !!isError)).catch((e) => console.error('[launcher] showStatus:', e.message));
}

function showPastePage() {
  state.currentPage = showPastePage;
  const body = `
    ${tr(`<p>Похоже, <code>dsh</code> уже запущен, но у окна нет валидного сессионного куки
       (он мог истечь или dsh был перезапущен с другим секретом).</p>
    <p>В терминале, где работает dsh, найдите строку
       <code>dsh web: ${PLAIN_URL}?token=…</code> и вставьте сюда полный URL
       (или только токен):</p>`,
    `<p>It looks like <code>dsh</code> is already running, but the window has no valid
       session cookie (it may have expired, or dsh was restarted with a different secret).</p>
    <p>In the terminal where dsh is running, find the line
       <code>dsh web: ${PLAIN_URL}?token=…</code> and paste the full URL here
       (or just the token):</p>`)}
    <input id="u" type="text" placeholder="${PLAIN_URL}?token=…" autocomplete="off" spellcheck="false">
    <button onclick="go()">${tr('Открыть', 'Open')}</button>
    ${tr(`<p style="margin-top:16px">Токен взять неоткуда (dsh запущен сервисом, терминала нет)?
        Тогда остановите dsh (например, <code>pkill -f 'dsh --profile web'</code>), закройте
        это окно и запустите <code>dsh-launcher</code> снова — лаунчер поднимет dsh сам и
        подключится без токена.</p>`,
    `<p style="margin-top:16px">No way to get the token (dsh runs as a service, no terminal)?
        Then stop dsh (e.g. <code>pkill -f 'dsh --profile web'</code>), close this
        window and start <code>dsh-launcher</code> again — the launcher will start dsh itself
        and connect without a token.</p>`)}
    <script>
      const el = document.getElementById('u');
      el.focus();
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      function go() {
        const v = el.value.trim();
        if (!v) return;
        const url = /^https?:\\/\\//i.test(v) ? v : '${PLAIN_URL}?token=' + encodeURIComponent(v);
        location.href = 'dshlauncher://paste/' + encodeURIComponent(url);
      }
    </script>`;
  showStatus(tr('Нужен токен', 'Token required'), body, true);
}

/* ---------------- страница «dsh не установлен» ----------------
 * Порт закрыт и бинарника dsh нет — вместо попытки старта и ENOENT показываем
 * инструкцию: команда установки, «Скопировать», (если глобальный npm prefix
 * доступен без sudo) «Установить» с живым логом, и «Проверить ещё раз».
 * Состояние кэшируем: во время установки страница перерисовывается каждые
 * 800 мс, и запускать проверки в каждом рендере незачем.
 */
let installState = { check: null, npmInfo: null, running: false, log: [], timer: null, proc: null };

async function refreshInstallState() {
  [installState.check, installState.npmInfo] = await Promise.all([dshInstallCheck(), npmInstallInfo()]);
}

async function showInstallPage(note, noteIsError = false) {
  if (!state.win || state.win.isDestroyed()) return;
  state.currentPage = () => showInstallPage(note, noteIsError);
  if (typeof note === 'function') note = note();
  if (!installState.running) {
    try { await refreshInstallState(); } catch (e) { console.error('[launcher] refreshInstallState:', e.message); }
    if (!state.win || state.win.isDestroyed() || !installState.check) return;
  }
  const check = installState.check;
  const npmInfo = installState.npmInfo;
  const installing = installState.running;
  const noteHtml = note
    ? `<p style="color:${noteIsError ? '#f85149' : '#3fb950'}">${esc(note)}</p>`
    : '';
  const body = `
    ${noteHtml}
    <p>${installing
      ? tr(`Лаунчер не может запустить DeepSeek Harness: идёт установка <code>dsh</code>.`,
           `The launcher cannot start DeepSeek Harness: <code>dsh</code> is being installed.`)
      : check.reason === 'missing' && DSH_BIN_EXPLICIT
        ? tr(`Лаунчер не может запустить DeepSeek Harness: по пути <code>${esc(state.dshBin)}</code> бинарника <code>dsh</code> нет.`,
             `The launcher cannot start DeepSeek Harness: there is no <code>dsh</code> binary at <code>${esc(state.dshBin)}</code>.`)
      : check.reason === 'missing'
        ? tr(`Лаунчер не нашёл <code>dsh</code>: искал <code>${DSH_BIN_DEFAULT}</code>, в PATH, в каталогах npm и nvm.`,
             `The launcher could not find <code>dsh</code>: looked at <code>${DSH_BIN_DEFAULT}</code>, in PATH, and in npm and nvm directories.`)
        : tr(`Лаунчер не может запустить DeepSeek Harness: бинарник <code>${esc(state.dshBin)}</code> не запускается.`,
             `The launcher cannot start DeepSeek Harness: the <code>${esc(state.dshBin)}</code> binary fails to run.`)}</p>
    ${!installing && check.detail ? `<p>${tr('Детали', 'Details')}: <code>${esc(check.detail)}</code></p>` : ''}
    ${installing
      ? `<p>${tr('Последние строки установки:', 'Latest install output:')}</p>\n     <pre>` + esc(installState.log.slice(-40).join('\n') || '…') + '</pre>'
      : `<p>${tr('Установите dsh (нужен Node.js 22+ и npm):', 'Install dsh (requires Node.js 22+ and npm):')}</p>\n     <pre>` + esc(npmInfo.command) + '</pre>\n     ' + (
          npmInfo.nodeOld
            ? tr(`<p>Но сейчас найден Node.js <code>${esc(npmInfo.nodeVersion)}</code>, а dsh нужен Node.js ${MIN_NODE_MAJOR} или новее — на нём dsh не запустится. Сначала обновите Node.js (например, через nvm: <code>nvm install ${MIN_NODE_MAJOR}</code>, или пакеты NodeSource), затем установите dsh и нажмите «Проверить ещё раз».</p>`,
                 `<p>However, Node.js <code>${esc(npmInfo.nodeVersion)}</code> was found, and dsh needs Node.js ${MIN_NODE_MAJOR} or newer — dsh will not run on it. Upgrade Node.js first (e.g. with nvm: <code>nvm install ${MIN_NODE_MAJOR}</code>, or NodeSource packages), then install dsh and click “Check again”.</p>`)
          : npmInfo.canAuto
            ? tr('<p>Или нажмите «Установить» — лаунчер выполнит команду сам.</p>',
                 '<p>Or click “Install” — the launcher will run the command for you.</p>')
            : npmInfo.hasNpm
              ? tr('<p>Этой команде нужен <code>sudo</code> — выполните её в терминале и нажмите «Проверить ещё раз».</p>',
                   '<p>This command needs <code>sudo</code> — run it in a terminal and click “Check again”.</p>')
              : tr('<p>npm в системе нет: сначала установите Node.js (22+) с npm, затем команду выше, и нажмите «Проверить ещё раз».</p>',
                   '<p>npm is not installed: install Node.js (22+) with npm first, then the command above, and click “Check again”.</p>')
        )}
    <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap">
      ${installing ? '' : `<button onclick="location.href='dshlauncher://install/copy/'">${tr('Скопировать команду', 'Copy command')}</button>`}
      ${installing ? '' : (npmInfo.canAuto ? `<button onclick="location.href='dshlauncher://install/run/'">${tr('Установить', 'Install')}</button>` : '')}
      <button onclick="location.href='dshlauncher://install/recheck/'">${tr('Проверить ещё раз', 'Check again')}</button>
    </div>`;
  showStatus(installing ? tr('Устанавливаю dsh…', 'Installing dsh…') : tr('Нужен DeepSeek Harness', 'DeepSeek Harness is required'), body, !installing);
}

/* ---------------- плагин маркета (dshmarket) ----------------
 * Перед тем как лаунчер сам запускает dsh, проверяем, что в профиле стоит
 * плагин маркета. Если нет — спрашиваем пользователя: «Установить»
 * (dsh plugin --profile <профиль> add dshmarket, с живым логом), «Не сейчас»
 * или «Не спрашивать больше» (запоминается в userData/market-prompt.json).
 * Ставим именно до старта: плагины dsh подхватывает при запуске. К уже
 * запущенному dsh (режим подключения) вопрос не задаём.
 * Проверка — чтение $DSH_HOME/profiles/<профиль>/package.json (по умолчанию
 * ~/.dsh), без запуска dsh.
 */
const MARKET_PKG = 'dshmarket';


const DSH_PROFILE = profileFromArgs(DSH_ARGS);

/* ===== marketInPkg (чистая функция, тест test/parsing.js) =====
   Есть ли плагин маркета в package.json профиля: в dependencies или в
   dsh.profile.bundles. */
function marketInPkg(pkg) {
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  return Boolean(pkg.dependencies && pkg.dependencies[MARKET_PKG]) || bundles.includes(MARKET_PKG);
}
/* ===== end marketInPkg ===== */

function marketInstalled() {
  if (!DSH_PROFILE) return true; // профиль не задан — не знаем, где смотреть, не спрашиваем
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const pkgFile = path.join(dshHome, 'profiles', DSH_PROFILE, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    return marketInPkg(pkg);
  } catch {
    return false; // профиля ещё нет — dsh plugin add создаст его сам
  }
}

const marketPrefFile = () => path.join(app.getPath('userData'), 'market-prompt.json');

function marketPromptDisabled() {
  try { return JSON.parse(fs.readFileSync(marketPrefFile(), 'utf8')).dontAsk === true; }
  catch { return false; }
}

let marketState = { resolve: null, running: false, log: [], timer: null, proc: null, cmdLine: null };

function marketCommand() {
  return `${state.dshBin} plugin --profile ${DSH_PROFILE} add ${MARKET_PKG}`;
}

function showMarketPage(note, noteIsError = false) {
  state.currentPage = () => showMarketPage(note, noteIsError);
  if (typeof note === 'function') note = note();
  const installing = marketState.running;
  const noteHtml = note
    ? `<p style="color:${noteIsError ? '#f85149' : '#3fb950'}">${esc(note)}</p>`
    : '';
  const body = installing
    ? `<p>${tr('Выполняю', 'Running')} <code>${esc(marketState.cmdLine || marketCommand())}</code></p>
       <p>${tr('Последние строки установки:', 'Latest install output:')}</p>
       <pre>${esc(marketState.log.slice(-40).join('\n') || '…')}</pre>`
    : `${noteHtml}
       <p>${tr(`В профиле <code>${esc(DSH_PROFILE)}</code> не найден плагин маркета
          <code>${MARKET_PKG}</code>. Установить его перед запуском dsh?`,
          `The marketplace plugin <code>${MARKET_PKG}</code> is not installed in the
          <code>${esc(DSH_PROFILE)}</code> profile. Install it before starting dsh?`)}</p>
       <pre>${esc(marketCommand())}</pre>
       ${noteIsError && marketState.log.length ? `<pre>${esc(marketState.log.slice(-20).join('\n'))}</pre>` : ''}
       <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap">
         <button onclick="location.href='dshlauncher://market/install/'">${tr('Установить', 'Install')}</button>
         <button onclick="location.href='dshlauncher://market/skip/'">${tr('Не сейчас', 'Not now')}</button>
         <button onclick="location.href='dshlauncher://market/never/'">${tr('Не спрашивать больше', 'Don’t ask again')}</button>
       </div>`;
  showStatus(installing ? tr(`Устанавливаю ${MARKET_PKG}…`, `Installing ${MARKET_PKG}…`)
    : tr(`Установить ${MARKET_PKG}?`, `Install ${MARKET_PKG}?`), body, noteIsError);
}

// Показывает вопрос и ждёт нажатия: 'install' | 'skip' | 'never'.
function askMarket(note, noteIsError) {
  return new Promise((resolve) => {
    marketState.resolve = resolve;
    showMarketPage(note, noteIsError);
  });
}

function onMarketChoice(choice) {
  const resolve = marketState.resolve;
  if (resolve && !marketState.running) {
    marketState.resolve = null;
    resolve(choice);
  }
  return blankResponse();
}

// dsh plugin add вызывает pnpm — его каталог тоже должен быть в PATH.
function marketEnv() {
  const env = dshEnv();
  const pnpm = findBin('pnpm');
  if (pnpm) env.PATH = path.dirname(pnpm) + path.delimiter + env.PATH;
  return env;
}

// Запуск шага установки (pnpm или сам маркет) с живым логом на странице.
async function runMarketInstall(cmd, args, env) {
  marketState.running = true;
  marketState.log = [];
  marketState.cmdLine = [cmd, ...args].join(' ');
  console.log(`[launcher] установка: ${marketState.cmdLine}`);
  try {
    const p = spawn(cmd, args, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
    marketState.proc = p;
    const onData = (d) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        marketState.log.push(t);
        if (marketState.log.length > 500) marketState.log.shift();
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    showMarketPage();
    marketState.timer = setInterval(() => showMarketPage(), 800);
    return await new Promise((resolve) => {
      let settled = false;
      const done = (c) => { if (!settled) { settled = true; resolve(c); } };
      p.on('close', (c) => done(c === null ? -1 : c));
      p.on('error', (e) => { marketState.log.push(e.message); done(-1); });
    });
  } finally {
    clearInterval(marketState.timer);
    marketState.running = false;
    marketState.proc = null;
  }
}

async function offerMarketIfMissing() {
  if (marketInstalled()) return;
  if (marketPromptDisabled()) {
    console.log(`[launcher] ${MARKET_PKG} не установлен, вопрос отключён (${marketPrefFile()})`);
    return;
  }
  console.log(`[launcher] ${MARKET_PKG} не установлен в профиле ${DSH_PROFILE} — спрашиваю пользователя`);
  let note = null;
  let noteIsError = false;
  for (;;) {
    const choice = await askMarket(note, noteIsError);
    if (state.stopping) return;
    if (choice === 'never') {
      try {
        fs.mkdirSync(path.dirname(marketPrefFile()), { recursive: true });
        fs.writeFileSync(marketPrefFile(), JSON.stringify({ dontAsk: true }));
      } catch (e) { console.error('[launcher] market-prompt.json:', e.message); }
      console.log('[launcher] пользователь отказался от маркета навсегда');
      return;
    }
    if (choice !== 'install') {
      console.log('[launcher] установка маркета отложена (не сейчас)');
      return;
    }
    // dsh plugin add требует pnpm: на чистой системе его нет (код 127).
    if (!findBin('pnpm')) {
      const npmInfo = await npmInstallInfo();
      if (state.stopping) return;
      if (!npmInfo.canAuto) {
        const cmd = npmInfo.hasNpm ? 'sudo npm install -g pnpm' : 'npm install -g pnpm';
        console.log(`[launcher] pnpm нет, поставить сами не можем — прошу «${cmd}»`);
        marketState.log = [];
        note = () => tr(`Для плагинов dsh нужен pnpm, а его в системе нет. Выполните в терминале «${cmd}» и нажмите «Установить» ещё раз.`,
          `dsh plugins need pnpm, which is not installed. Run “${cmd}” in a terminal and click “Install” again.`);
        noteIsError = true;
        continue;
      }
      console.log('[launcher] pnpm нет — ставлю через npm');
      const pc = await runMarketInstall(npmInfo.npm, ['install', '-g', 'pnpm'], envWithBinDir(npmInfo.npm));
      if (state.stopping) return;
      if (pc !== 0 || !findBin('pnpm')) {
        console.error(`[launcher] установка pnpm не удалась (код ${pc})`);
        note = () => tr(`Не удалось установить pnpm (код ${pc}). Можно повторить или продолжить без маркета.`,
          `Failed to install pnpm (code ${pc}). You can retry or continue without the marketplace.`);
        noteIsError = true;
        continue;
      }
    }
    const code = await runMarketInstall(state.dshBin, ['plugin', '--profile', DSH_PROFILE, 'add', MARKET_PKG], marketEnv());
    if (state.stopping) return;
    if (code === 0 && marketInstalled()) {
      console.log(`[launcher] ${MARKET_PKG} установлен`);
      return;
    }
    console.error(`[launcher] установка ${MARKET_PKG} не удалась (код ${code})`);
    note = () => tr(`Установка не удалась (код ${code}). Можно повторить или продолжить без маркета.`,
      `Installation failed (code ${code}). You can retry or continue without the marketplace.`);
    noteIsError = true;
  }
}

/* ---------------- проверка обновлений (лаунчер и dsh) ----------------
 * При старте (в onReady, параллельно со всем остальным) проверяем:
 *  - последний релиз dsh-launcher (GitHub Releases Toximiner/DSH-Launcher);
 *  - последнюю версию npm-пакета @deepseek-ai/dsh.
 * Запросы уходят сразу при старте, параллельно остальному; перед запуском
 * dsh лаунчер ждёт их ответа не дольше ~8 с (без сети запрос падает сразу).
 * Сетевая ошибка или таймаут — просто без вопроса (в логе — строка).
 *
 * На пути само-запуска (перед стартом dsh) при наличии новой версии окно
 * спрашивает (тот же паттерн, что вопрос про маркет):
 *  - лаунчер: скачивает .deb из релиза в userData/updates/ (sha256 считается
 *    на лету и сверяется с digest ассета из GitHub API) и ставит его от root
 *    через pkexec — polkit спросит пароль системным диалогом. Под root пакет
 *    сначала копируется в свой каталог и сверяется с тем же sha256 — подмена
 *    файла в userData между скачиванием и установкой не пройдёт. Успех →
 *    страница «Обновление установлено» и авто-перезапуск через ~1.5 с: старый
 *    экземпляр отпускает single-instance лок, запускает новый и закрывается.
 *    Нет pkexec / отменили ввод пароля / ошибка → страница с командой для
 *    терминала (`sudo apt install -y <deb>`) и «Проверить ещё раз»;
 *  - dsh: если глобальный npm-prefix доступен без sudo —
 *    `npm install -g @deepseek-ai/dsh@<версия>` с живым логом; иначе —
 *    страница с командой для терминала и «Проверить ещё раз». После успеха
 *    dsh стартует сразу с новой версией.
 *
 * В режиме подключения (dsh уже работает из-вне) не спрашиваем: чужой dsh
 * перезапускать нельзя, а обновление самого лаунчера предложим при
 * следующем само-запуске. «Не спрашивать больше» запоминается на версию
 * (userData/update-prefs.json) — новый релиз спросит снова.
 *
 * Переменные окружения:
 *  DSH_LAUNCHER_NO_UPDATE_CHECK=1 — проверки отключены;
 *  DSH_LAUNCHER_FAKE_LAUNCHER_LATEST / DSH_LAUNCHER_FAKE_DSH_LATEST —
 *    «будущая» версия для разработки и тестов (у лаунчера .deb всё равно
 *    берётся из настоящего latest-релиза);
 *  DSH_LAUNCHER_FAKE_INSTALLED — «установленная» версия лаунчера (тесты).
 */
const DSH_NPM_PKG = '@deepseek-ai/dsh';
const UPDATE_GITHUB_REPO = 'Toximiner/DSH-Launcher';
const UPDATE_CHECK_TIMEOUT = 8000; // сколько ждать проверки, прежде чем не спрашивать
const NO_UPDATE_CHECK = !CONFIG.checkUpdates; // DSH_LAUNCHER_NO_UPDATE_CHECK или «Настройки»





// Установленная версия лаунчера через dpkg (пакет .deb dsh-launcher).
// null — не установлен через .deb (запуск из исходников) → не проверяем.


// Версия пакета лаунчера — из базы dpkg, без запуска dpkg-query: запуск
// дочернего процесса во время загрузки окна-диалога ронял Electron 44
// («О программе»: SIGSEGV / «terminate called without an active exception»).
async function launcherInstalledVersion() {
  const fake = process.env.DSH_LAUNCHER_FAKE_INSTALLED;
  if (fake) return String(fake);
  try {
    return dpkgStatusVersion(await fs.promises.readFile('/var/lib/dpkg/status', 'utf8'), 'dsh-launcher');
  } catch {
    return null;
  }
}

// Проверка с дедлайном: по истечении ms возвращает null — медленная сеть
// не должна держать окно на вопросе, а вопрос — не держать старт.


// Внешние запросы (GitHub, npm, скачивание .deb) — через http/https из Node,
// а не electronNet.fetch. После electronNet.fetch к внешним хостам при старте
// следующий запуск дочернего процесса (dpkg-query, dsh --version в «О
// программе») ронял Electron 44 в нативном коде: «terminate called without
// an active exception» / SIGSEGV (Wayland, Ubuntu 26.04; 1.3.0). Системный
// прокси берём у Chromium (session.resolveProxy — настройки GNOME/KDE и
// переменные окружения) и передаём агенту Node (proxyEnv, Node 24.5+).
// Проверка куки окна (plainUrlIsAuthed) остаётся на electronNet — ей нужна
// сессия окна.



async function proxyAgentFor(u) {
  let rule = 'DIRECT';
  try { rule = await session.defaultSession.resolveProxy(u.toString()); } catch { /* напрямую */ }
  const proxy = proxyUrlFromRule(rule);
  if (!proxy) return undefined;
  const isHttp = u.protocol === 'http:';
  return new (isHttp ? http : https).Agent({ proxyEnv: { [isHttp ? 'HTTP_PROXY' : 'HTTPS_PROXY']: proxy } });
}

/* ===== httpGet (тест test/http.js, с подставным агентом) =====
   GET с переходами по редиректам (ассеты релизов GitHub отдаются через 302)
   → поток ответа (http.IncomingMessage): statusCode, headers, данные. */
async function httpGet(url, { headers = {}, maxRedirects = 5, timeoutMs = 30000 } = {}) {
  const u = new URL(url);
  const agent = await proxyAgentFor(u);
  const res = await new Promise((resolve, reject) => {
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers, agent }, resolve);
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`таймаут ${timeoutMs / 1000} с: ${u.host}`)));
  });
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    res.resume();
    if (maxRedirects <= 0) throw new Error('слишком много перенаправлений');
    return httpGet(new URL(res.headers.location, u).toString(), { headers, maxRedirects: maxRedirects - 1, timeoutMs });
  }
  return res;
}
/* ===== end httpGet ===== */

async function httpJson(url, headers, what) {
  const res = await httpGet(url, { headers });
  let body = '';
  res.setEncoding('utf8');
  for await (const c of res) body += c;
  if (res.statusCode !== 200) throw new Error(`${what}: HTTP ${res.statusCode}`);
  return JSON.parse(body);
}



// Кэш списка релизов: без метки ETag — не спрашивать GitHub чаще раза в час;
// GitHub не ответил — список из кэша, если он не старше часа.
const RELEASES_MAX_AGE_MS = 60 * 60 * 1000;
const releasesCacheFile = () => path.join(app.getPath('userData'), 'releases-cache.json');

// Список релизов GitHub с учётом кэша (см. releasesCacheMode).
async function githubReleases({ force = false } = {}) {
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(releasesCacheFile(), 'utf8')); } catch { /* кэша нет */ }
  const mode = releasesCacheMode(entry, Date.now(), RELEASES_MAX_AGE_MS, force);
  if (mode === 'cache') return entry.list;
  const headers = { 'User-Agent': 'dsh-launcher', 'Accept': 'application/vnd.github+json' };
  if (mode === 'revalidate') headers['If-None-Match'] = entry.etag;
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`; // только api.github.com
  let res;
  let body = '';
  try {
    res = await httpGet(`https://api.github.com/repos/${UPDATE_GITHUB_REPO}/releases?per_page=20`, { headers });
    res.setEncoding('utf8');
    for await (const c of res) body += c;
    if (res.statusCode !== 200 && !(res.statusCode === 304 && entry)) throw new Error(`GitHub API: HTTP ${res.statusCode}`);
  } catch (e) {
    // нет сети, лимит, сбой GitHub — недавний список лучше никакого
    if (!force && releasesCacheFresh(entry, Date.now(), RELEASES_MAX_AGE_MS)) {
      console.log(`[launcher] релизы GitHub: ${e.message} — список из кэша`);
      return entry.list;
    }
    throw e;
  }
  let list;
  if (res.statusCode === 304) {
    list = entry.list;
    console.log('[launcher] релизы GitHub: не изменились (304, лимит не расходуется)');
  } else {
    list = JSON.parse(body);
    entry = { etag: res.headers.etag || null, list };
  }
  try {
    fs.mkdirSync(path.dirname(releasesCacheFile()), { recursive: true });
    fs.writeFileSync(releasesCacheFile(), JSON.stringify({ ...entry, fetchedAt: Date.now() }));
  } catch { /* кэш — не обязателен */ }
  return list;
}

// Список релизов (одним запросом): последний — наибольшая версия среди
// опубликованных (не черновик, не prerelease); описания остальных — для
// «Что нового» (изменения между установленной и новой версией).
async function fetchLauncherLatest({ force = false } = {}) {
  const list = await githubReleases({ force });
  const rels = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft && !r.prerelease && r.tag_name);
  if (!rels.length) throw new Error('GitHub API: нет опубликованных релизов');
  const ver = (r) => String(r.tag_name).replace(/^v/, '');
  const j = rels.reduce((a, b) => (compareDebianVer(tagToPackageVersion(ver(b)), tagToPackageVersion(ver(a))) > 0 ? b : a));
  const asset = (j.assets || []).find((a) => String(a.name).endsWith('.deb'));
  const meta = {
    version: ver(j),
    htmlUrl: j.html_url || null,
    assetUrl: asset ? asset.browser_download_url : null,
    // GitHub отдаёт digest ассета вида «sha256:<hex>» (у старых релизов может не быть)
    assetSha256: asset && /^sha256:[0-9a-f]{64}$/i.test(String(asset.digest || ''))
      ? String(asset.digest).slice(7).toLowerCase()
      : null,
    releases: rels.map((r) => ({ version: ver(r), body: String(r.body || '') })),
  };
  const fake = fakeLatest('DSH_LAUNCHER_FAKE_LAUNCHER_LATEST'); // разработка/тесты
  if (fake) meta.version = fake;
  return meta;
}







// Блок «Что нового» — версии от новой к старой; пусто — ''.
function notesBlockHtml(items) {
  const parts = (items || [])
    .map((r) => ({ v: r.version, html: mdToHtml(releaseNotesLang(r.body, UI_LANG)) }))
    .filter((r) => r.html);
  if (!parts.length) return '';
  return `<p style="margin:14px 0 6px; color:#d7dce3">${tr('Что нового:', 'What’s new:')}</p>
    <div class="notes">${parts.map((r) => `<div class="ver"><code>${esc(r.v)}</code></div>${r.html}`).join('')}</div>`;
}

async function fetchDshLatest() {
  const j = await httpJson(`https://registry.npmjs.org/${DSH_NPM_PKG}/latest`,
    { 'User-Agent': 'dsh-launcher' }, 'npm registry');
  const version = String(j.version || '');
  if (!version) throw new Error('нет версии в ответе npm');
  const meta = { version, htmlUrl: `https://www.npmjs.com/package/${DSH_NPM_PKG}` };
  const fake = fakeLatest('DSH_LAUNCHER_FAKE_DSH_LATEST'); // разработка/тесты
  if (fake) meta.version = fake;
  return meta;
}

// Подставная «последняя» версия (разработка/тесты): значение переменной или,
// если это путь, — содержимое файла (читается при каждой проверке).
function fakeLatest(name) {
  const v = process.env[name];
  if (!v || !v.startsWith('/')) return v || null;
  try { return fs.readFileSync(v, 'utf8').trim() || null; } catch { return null; }
}

let updateChecks = { launcher: null, dsh: null };

// При старте — оба запроса в параллель (здесь не ждём их завершения).
function startUpdateChecks() {
  if (GITHUB_TOKEN) console.log('[launcher] запросы к GitHub API — с токеном (DSH_LAUNCHER_GITHUB_TOKEN)');
  if (UPDATE_NOW) console.log(`[launcher] обновление ${UPDATE_NOW} — по просьбе пользователя, без вопроса`);
  if (NO_UPDATE_CHECK && !UPDATE_NOW) {
    console.log('[launcher] проверка обновлений отключена (DSH_LAUNCHER_NO_UPDATE_CHECK)');
    return;
  }
  updateChecks = {
    launcher: timedCheck(fetchLauncherLatest(), UPDATE_CHECK_TIMEOUT).then((v) => {
      if (v) console.log(`[launcher] последний dsh-launcher: ${v.version}`);
      return v;
    }),
    dsh: timedCheck(fetchDshLatest(), UPDATE_CHECK_TIMEOUT).then((v) => {
      if (v) console.log(`[launcher] последний ${DSH_NPM_PKG}: ${v.version}`);
      return v;
    }),
  };
}

let updateState = {
  kind: null,          // 'launcher' | 'dsh' — какой вопрос сейчас на странице
  mode: 'ask',         // 'ask' | 'running' | 'manual' | 'success'
  resolve: null,       // resolve текущего вопроса
  running: false,      // идёт процесс (скачивание / установка)
  log: [], timer: null, proc: null, cmdLine: null,
  latest: null,        // новая версия (текст вопроса)
  installed: null,     // текущая версия
  htmlUrl: null,       // страница релиза (у dsh — страница пакета npm)
  notes: [],           // «Что нового»: релизы между установленной и новой версией (лаунчер)
  debPath: null,       // скачанный .deb
  manualCmd: null,     // команда для терминала (режим manual)
  restartTimer: null,
};

const updatePrefFile = () => path.join(app.getPath('userData'), 'update-prefs.json');

function updatePrefs() {
  try { return JSON.parse(fs.readFileSync(updatePrefFile(), 'utf8')); }
  catch { return {}; }
}

// «Не спрашивать больше» — на версию: отказ от старой не скрывает новую.
function updateDismissed(kind, version) {
  return updatePrefs()[kind] === version;
}

function updateDismiss(kind, version) {
  try {
    const p = updatePrefs();
    p[kind] = version;
    fs.mkdirSync(path.dirname(updatePrefFile()), { recursive: true });
    fs.writeFileSync(updatePrefFile(), JSON.stringify(p));
    console.log(`[launcher] ${kind}: «не спрашивать больше» до версии ${version}`);
  } catch (e) {
    console.error('[launcher] update-prefs.json:', e.message);
  }
}

function showUpdatePage(note, noteIsError = false) {
  if (!state.win || state.win.isDestroyed()) return;
  state.currentPage = () => showUpdatePage(note, noteIsError);
  if (typeof note === 'function') note = note();
  const kind = updateState.kind;
  const mode = updateState.mode;
  const noteHtml = note
    ? `<p style="color:${noteIsError ? '#f85149' : '#3fb950'}">${esc(note)}</p>`
    : '';
  const link = updateState.htmlUrl
    ? `<a href="${esc(updateState.htmlUrl)}" target="_blank">${kind === 'dsh'
        ? tr('Страница пакета (npm)', 'Package page (npm)')
        : tr('Страница релиза (GitHub)', 'Release page (GitHub)')}</a>`
    : '';
  let title;
  let body;
  if (mode === 'running') {
    title = kind === 'dsh'
      ? tr('Обновление DeepSeek Harness…', 'Updating DeepSeek Harness…')
      : tr('Обновление DeepSeek Harness Launcher…', 'Updating DeepSeek Harness Launcher…');
    body = `
      ${noteHtml}
      <p>${tr('Выполняю', 'Running')} <code>${esc(updateState.cmdLine || '')}</code></p>
      <p>${tr('Последние строки:', 'Latest output lines:')}</p>
      <pre>${esc(updateState.log.slice(-40).join('\n') || '…')}</pre>`;
  } else if (mode === 'success') {
    title = tr('Обновление установлено', 'Update installed');
    body = `
      ${noteHtml}
      <p>${tr(
        `Установлена версия <code>${esc(updateState.latest)}</code>. Приложение перезапустится через пару секунд (или нажмите кнопку).`,
        `Version <code>${esc(updateState.latest)}</code> is installed. The app will restart in a couple of seconds (or click the button).`)}</p>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap">
        <button onclick="location.href='dshlauncher://update/restart/'">${tr('Перезапустить сейчас', 'Restart now')}</button>
      </div>`;
  } else if (mode === 'manual') {
    title = tr('Обновить вручную', 'Update manually');
    body = `
      ${noteHtml}
      ${updateState.manualCmd
        ? `<p>${tr('Лаунчер не смог обновиться сам. Выполните в терминале:', 'The launcher cannot update itself. Run in a terminal:')}</p>
           <pre>${esc(updateState.manualCmd)}</pre>`
        : ''}
      ${kind === 'launcher' && updateState.debPath
        ? `<p>${tr('Скачанный пакет:', 'Downloaded package:')} <code>${esc(updateState.debPath)}</code></p>`
        : ''}
      ${link ? `<p>${link}</p>` : ''}
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap">
        ${updateState.manualCmd ? `<button onclick="location.href='dshlauncher://update/copy/'">${tr('Скопировать команду', 'Copy command')}</button>` : ''}
        <button onclick="location.href='dshlauncher://update/recheck/'">${tr('Проверить ещё раз', 'Check again')}</button>
        <button onclick="location.href='dshlauncher://update/later/'">${tr('Не сейчас', 'Not now')}</button>
        <button onclick="location.href='dshlauncher://update/never/'">${tr('Не спрашивать больше', 'Don’t ask again')}</button>
      </div>`;
  } else {
    // ask
    title = kind === 'dsh'
      ? tr('Обновить DeepSeek Harness?', 'Update DeepSeek Harness?')
      : tr('Обновить DeepSeek Harness Launcher?', 'Update DeepSeek Harness Launcher?');
    body = `
      ${noteHtml}
      <p>${tr(
        `Доступна версия <code>${esc(updateState.latest)}</code> (установлена: <code>${esc(updateState.installed)}</code>). Обновиться?`,
        `Version <code>${esc(updateState.latest)}</code> is available (installed: <code>${esc(updateState.installed)}</code>). Update?`)}</p>
      ${kind === 'launcher' ? notesBlockHtml(updateState.notes) : ''}
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap">
        <button onclick="location.href='dshlauncher://update/install/'">${tr('Обновить', 'Update')}</button>
        <button onclick="location.href='dshlauncher://update/later/'">${tr('Не сейчас', 'Not now')}</button>
        <button onclick="location.href='dshlauncher://update/never/'">${tr('Не спрашивать больше', 'Don’t ask again')}</button>
        ${link}
      </div>`;
  }
  showStatus(title, body, noteIsError);
}

// Показывает вопрос (режим ask/manual) и ждёт выбора:
// 'install' | 'later' | 'never' | 'recheck'. 'copy' и 'restart' вопрос не
// разрешают (перерисовывают страницу / закрывают приложение).
function askUpdate(note, noteIsError) {
  return new Promise((resolve) => {
    updateState.resolve = resolve;
    showUpdatePage(note, noteIsError);
  });
}

function onUpdateChoice(choice) {
  if (choice === 'copy') {
    if (updateState.manualCmd) {
      clipboard.writeText(updateState.manualCmd);
      showUpdatePage(tr('Команда скопирована в буфер обмена.', 'Command copied to the clipboard.'), false);
    }
    return blankResponse();
  }
  if (choice === 'restart') {
    restartLauncher();
    return blankResponse();
  }
  const resolve = updateState.resolve;
  if (resolve && !updateState.running) {
    updateState.resolve = null;
    resolve(choice);
  }
  return blankResponse();
}

// Шаг установки с живым логом на странице (паттерн runMarketInstall).
async function runUpdateStep(cmd, args, env) {
  updateState.running = true;
  updateState.mode = 'running';
  updateState.log = [];
  updateState.cmdLine = [cmd, ...args].join(' ');
  console.log(`[launcher] шаг обновления: ${updateState.cmdLine}`);
  try {
    const p = spawn(cmd, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    updateState.proc = p;
    const onData = (d) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        updateState.log.push(t);
        if (updateState.log.length > 500) updateState.log.shift();
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    showUpdatePage();
    updateState.timer = setInterval(() => showUpdatePage(), 800);
    return await new Promise((resolve) => {
      let settled = false;
      const done = (c) => { if (!settled) { settled = true; resolve(c); } };
      p.on('close', (c) => done(c === null ? -1 : c));
      p.on('error', (e) => { updateState.log.push(e.message); done(-1); });
    });
  } finally {
    try { clearInterval(updateState.timer); } catch { /* noop */ }
    updateState.running = false;
    updateState.proc = null;
  }
}

// Скачивание .deb из релиза в userData/updates/. Прогресс — в логе на
// странице (те же 800 мс, что и установки). sha256 считается по байтам из
// сети (а не по файлу на диске) и, если GitHub его знает, сверяется с digest.
async function downloadDeb(url, expectedSha256) {
  updateState.running = true;
  updateState.mode = 'running';
  updateState.log = [];
  updateState.cmdLine = `download ${url}`;
  console.log(`[launcher] скачиваю ${url}`);
  const dir = path.join(app.getPath('userData'), 'updates');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Пакеты прошлых попыток больше не нужны — не копим их.
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.deb')) try { fs.unlinkSync(path.join(dir, f)); } catch { /* noop */ }
    }
    const res = await httpGet(url, { headers: { 'User-Agent': 'dsh-launcher' } }); // не electronNet — см. proxyUrlFromRule
    if (res.statusCode !== 200) { res.resume(); throw new Error(`download: HTTP ${res.statusCode}`); }
    const total = Number(res.headers['content-length'] || 0);
    const name = url.split('/').pop() || 'dsh-launcher.deb';
    const dest = path.join(dir, name);
    updateState.log.push(total ? `${name} (${(total / 1048576).toFixed(1)} МБ)` : name);
    const out = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha256');
    let got = 0;
    updateState.timer = setInterval(() => {
      updateState.log.push(total
        ? `${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ (${Math.round((100 * got) / total)}%)`
        : `${(got / 1048576).toFixed(1)} МБ`);
      if (updateState.log.length > 500) updateState.log.shift();
      showUpdatePage();
    }, 800);
    try {
      await new Promise((resolve, reject) => {
        const body = res;
        body.on('data', (c) => { got += c.length; hash.update(c); });
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        body.pipe(out);
      });
    } catch (e) {
      try { out.destroy(); } catch { /* noop */ }
      try { fs.unlinkSync(dest); } catch { /* noop */ }
      throw e;
    } finally {
      clearInterval(updateState.timer);
    }
    const sha256 = hash.digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
      try { fs.unlinkSync(dest); } catch { /* noop */ }
      throw new Error(`sha256 не совпадает с релизом (${sha256.slice(0, 12)}… ≠ ${expectedSha256.slice(0, 12)}…)`);
    }
    updateState.debPath = dest;
    console.log(`[launcher] скачал ${name} → ${dest} (sha256 ${sha256}${expectedSha256 ? ', совпадает с релизом' : ', digest в релизе нет'})`);
    return { ok: true, path: dest, sha256 };
  } catch (e) {
    console.error('[launcher] скачивание не удалось:', e.message);
    return { ok: false, err: e.message };
  } finally {
    updateState.running = false;
  }
}

// Перезапуск после обновления лаунчера: отпускаем single-instance лок, чтобы
// новый экземпляр сразу его взял, запускаем новый отсоединённым (он
// переживёт наш выход) и закрываемся штатно — через before-quit.
state.restarting = false;

function restartLauncher() {
  if (state.restarting || state.stopping) return;
  state.restarting = true;
  const exe = process.env.DSH_LAUNCHER_RESTART_BIN || '/usr/bin/dsh-launcher';
  app.releaseSingleInstanceLock();
  let started = false;
  const fail = (e) => {
    state.restarting = false;
    launcherUpdatedOnDisk = false; // не перезапускаться заново на каждом падении процесса
    app.requestSingleInstanceLock(); // остаёмся единственным экземпляром
    if (state.stopping) return;
    console.error('[launcher] авто-перезапуск не удался:', e.message);
    showUpdatePage(
      tr(`Не удалось запустить новую версию: ${e.message}. Обновление уже установлено — перезапустите лаунчер вручную.`,
         `Failed to start the new version: ${e.message}. The update is already installed — restart the launcher manually.`),
      true
    );
  };
  // запуск — через bash (spawnLauncherAfterExit): нет программы — узнаём здесь,
  // а не по 'error' (bash-то есть)
  try { fs.accessSync(exe, fs.constants.X_OK); } catch (e) { fail(e); return; }
  const p = spawnLauncherAfterExit(exe, [], 'ignore');
  p.on('spawn', () => { started = true; });
  p.on('error', fail);
  p.unref();
  // Даём событию 'error' chance (нет exe — сработает сразу): если процесс не
  // стартовал, приложение не закрываем — показана ошибка.
  setTimeout(() => {
    if (!started) return;
    console.log(`[launcher] запущена новая версия (${exe}), закрываю старую`);
    app.quit();
  }, 200);
}

// Лаунчер обновлён на диске, а работает ещё старый: apt заменил файлы
// /opt/dsh-launcher под нами. Уже открытые файлы живут (старые inode), но
// новые процессы Chromium (GPU, утилиты) запустились бы из нового бинарника —
// поэтому перезапускаемся быстро, а при падении любого процесса — сразу.
let launcherUpdatedOnDisk = false;

function showUpdateSuccess() {
  launcherUpdatedOnDisk = true;
  if (updateState.debPath) {
    try { fs.unlinkSync(updateState.debPath); } catch { /* noop */ }
    updateState.debPath = null;
  }
  updateState.mode = 'success';
  showUpdatePage();
  // ~1.5 с, чтобы страница успела показаться; если окно закроют раньше —
  // before-quit очистит таймер.
  updateState.restartTimer = setTimeout(() => restartLauncher(), 1500);
}

// Установка .deb от root (через pkexec). pkexec чистит окружение, поэтому
// DEBIAN_FRONTEND задаётся внутри. Пакет копируется в каталог root и
// сверяется с sha256, посчитанным при скачивании: файл в userData доступен
// пользователю на запись, и без копии его можно было бы подменить между
// проверкой и установкой. $1 — путь к .deb, $2 — sha256.
const ROOT_INSTALL_SH = [
  'set -e',
  'd=$(mktemp -d)',
  'trap \'rm -rf "$d"\' EXIT',
  'cp -- "$1" "$d/update.deb"',
  'echo "$2  $d/update.deb" | sha256sum -c --quiet -',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y "$d/update.deb"',
].join('; ');

// true — лаунчер обновлён и сейчас перезапустится: dsh этим экземпляром не
// запускаем (его поднимет новый).
async function offerLauncherUpdate() {
  if (UPDATE_NOW === 'dsh') return; // просили обновить dsh — о лаунчере спросим в другой раз
  const latest = await updateChecks.launcher;
  if (!latest || !latest.version) return; // нет сети / отключено / таймаут
  const installed = await launcherInstalledVersion();
  if (!installed) return; // не установлен через .deb (запуск из исходников)
  const latestPkg = tagToPackageVersion(latest.version);
  if (compareDebianVer(latestPkg, installed) <= 0) return; // новой версии нет
  if (UPDATE_NOW !== 'launcher' && updateDismissed('launcher', latest.version)) {
    console.log(`[launcher] обновление до ${latest.version} отклонено — не спрашиваю`);
    return;
  }
  console.log(`[launcher] новый dsh-launcher: ${latest.version} (установлен ${installed})`);
  updateState.kind = 'launcher';
  updateState.latest = latest.version;
  updateState.installed = installed;
  updateState.htmlUrl = latest.htmlUrl;
  updateState.notes = notesBetween(latest.releases, installed, latest.version, 'deb');
  updateState.mode = 'ask';
  updateState.debPath = null;
  updateState.manualCmd = null;
  let note = null;
  let noteIsError = false;
  let auto = UPDATE_NOW === 'launcher'; // «Обновить сейчас» — первый раз без вопроса
  for (;;) {
    const choice = auto ? 'install' : await askUpdate(note, noteIsError);
    auto = false;
    if (state.stopping) return;
    note = null;
    noteIsError = false;
    if (choice === 'never') {
      updateDismiss('launcher', latest.version);
      return;
    }
    if (choice === 'later') {
      console.log('[launcher] обновление лаунчера отложено (не сейчас)');
      return;
    }
    if (choice === 'recheck') {
      // Пользователь поставил .deb сам, в терминале.
      const now = await launcherInstalledVersion();
      if (now && compareDebianVer(latestPkg, now) <= 0) {
        updateState.installed = now;
        console.log(`[launcher] dsh-launcher обновлён до ${now} (вручную)`);
        showUpdateSuccess();
        return true;
      }
      updateState.mode = 'manual';
      note = tr(`Установлена версия ${now || 'неизвестно'}. Поставьте пакет и нажмите «Проверить ещё раз».`,
                `Installed version is ${now || 'unknown'}. Install the package and click "Check again".`);
      noteIsError = true;
      continue;
    }
    // choice === 'install'
    if (!latest.assetUrl) {
      updateState.mode = 'manual';
      note = tr('В этом релизе нет файла .deb — скачайте его со страницы релиза.',
                'This release has no .deb file — download it from the release page.');
      noteIsError = true;
      continue;
    }
    const dl = await downloadDeb(latest.assetUrl, latest.assetSha256);
    if (state.stopping) return;
    if (!dl.ok) {
      updateState.mode = 'manual';
      updateState.manualCmd = `curl -L -o dsh-launcher.deb ${latest.assetUrl} && sudo apt install -y ./dsh-launcher.deb`;
      note = tr(`Скачивание не удалось: ${dl.err}. Выполните команду выше в терминале и нажмите «Проверить ещё раз».`,
                `Download failed: ${dl.err}. Run the command above in a terminal and click "Check again".`);
      noteIsError = true;
      continue;
    }
    const pkexec = findBin('pkexec');
    if (!pkexec) {
      updateState.mode = 'manual';
      updateState.manualCmd = `sudo apt install -y ${dl.path}`;
      note = tr('pkexec в системе не найден — поставьте скачанный пакет командой выше.',
                'pkexec was not found on the system — install the downloaded package with the command above.');
      noteIsError = true;
      continue;
    }
    const code = await runUpdateStep(pkexec, ['/bin/sh', '-c', ROOT_INSTALL_SH, 'sh', dl.path, dl.sha256]);
    if (state.stopping) return;
    if (code === 0) {
      console.log(`[launcher] dsh-launcher ${latest.version} установлен`);
      showUpdateSuccess();
      return true;
    }
    // Отказ от ввода пароля polkit — тоже ненулевой код: команда для
    // терминала ссылается на уже скачанный пакет.
    console.error(`[launcher] pkexec apt-get завершился с кодом ${code} — даю команду вручную`);
    updateState.mode = 'manual';
    updateState.manualCmd = `sudo apt install -y ${dl.path}`;
    note = tr(`Установка не удалась (код ${code}). Если вы отменили ввод пароля — попробуйте ещё раз.`,
              `Installation failed (code ${code}). If you cancelled the password prompt — try again.`);
    noteIsError = true;
  }
}

// Текущая версия dsh: из dshInstallCheck при старте (onReady); если почему-
// то нет — пробинуем саму команду.
state.dshInstalledVersion = null;

async function offerDshUpdate() {
  const latest = await updateChecks.dsh;
  if (!latest || !latest.version) return;
  if (!state.dshInstalledVersion) {
    const r = await probeDsh(state.dshBin);
    if (!r.ok) return;
    state.dshInstalledVersion = r.version;
  }
  if (compareSemVer(latest.version, state.dshInstalledVersion) <= 0) return;
  if (UPDATE_NOW !== 'dsh' && updateDismissed('dsh', latest.version)) {
    console.log(`[launcher] обновление dsh до ${latest.version} отклонено — не спрашиваю`);
    return;
  }
  console.log(`[launcher] новый ${DSH_NPM_PKG}: ${latest.version} (установлен ${state.dshInstalledVersion})`);
  updateState.kind = 'dsh';
  updateState.notes = []; // у npm нет описаний версий — только ссылка на пакет
  updateState.latest = latest.version;
  updateState.installed = state.dshInstalledVersion;
  updateState.htmlUrl = latest.htmlUrl;
  updateState.mode = 'ask';
  updateState.debPath = null;
  updateState.manualCmd = null;
  const cmdAuto = `npm install -g ${DSH_NPM_PKG}@${latest.version}`;
  let note = null;
  let noteIsError = false;
  let auto = UPDATE_NOW === 'dsh'; // «Обновить сейчас» — первый раз без вопроса
  for (;;) {
    const choice = auto ? 'install' : await askUpdate(note, noteIsError);
    auto = false;
    if (state.stopping) return;
    note = null;
    noteIsError = false;
    if (choice === 'never') {
      updateDismiss('dsh', latest.version);
      return;
    }
    if (choice === 'later') {
      console.log('[launcher] обновление dsh отложено (не сейчас)');
      return;
    }
    if (choice === 'recheck') {
      const r = await probeDsh(state.dshBin);
      if (r.ok && compareSemVer(r.version, latest.version) >= 0) {
        state.dshInstalledVersion = r.version;
        console.log(`[launcher] dsh обновлён до ${r.version} (в терминале)`);
        return;
      }
      updateState.mode = 'manual';
      updateState.manualCmd = cmdAuto;
      note = tr(`Всё ещё версия ${r.ok ? r.version : 'неизвестно'}. Поставьте новую и нажмите «Проверить ещё раз».`,
                `Still version ${r.ok ? r.version : 'unknown'}. Install the new one and click "Check again".`);
      noteIsError = true;
      continue;
    }
    // choice === 'install'
    const npmInfo = await npmInstallInfo();
    if (state.stopping) return;
    if (!npmInfo.hasNpm || !npmInfo.canAuto) {
      // Глобальный prefix недоступен без sudo (или npm нет) — команда для
      // терминала.
      updateState.mode = 'manual';
      updateState.manualCmd = npmInfo.hasNpm ? `sudo ${cmdAuto}` : cmdAuto;
      if (npmInfo.nodeOld) {
        note = tr(`Node.js ${npmInfo.nodeVersion} слишком стар для dsh (нужен ${MIN_NODE_MAJOR}+). Сначала обновите Node.js, затем поставьте dsh командой выше.`,
                  `Node.js ${npmInfo.nodeVersion} is too old for dsh (${MIN_NODE_MAJOR}+ required). Upgrade Node.js first, then install dsh with the command above.`);
      } else if (!npmInfo.hasNpm) {
        note = tr('npm не найден — сначала установите Node.js (22+) с npm.',
                  'npm not found — install Node.js (22+) with npm first.');
      } else {
        note = tr('Эта команда требует sudo — выполните её в терминале и нажмите «Проверить ещё раз».',
                  'This command needs sudo — run it in a terminal and click "Check again".');
      }
      noteIsError = true;
      continue;
    }
    const code = await runUpdateStep(npmInfo.npm, ['install', '-g', `${DSH_NPM_PKG}@${latest.version}`], envWithBinDir(npmInfo.npm));
    if (state.stopping) return;
    if (code === 0) {
      const r = await probeDsh(state.dshBin);
      if (r.ok) state.dshInstalledVersion = r.version;
      if (r.ok && compareSemVer(r.version, latest.version) >= 0) {
        console.log(`[launcher] ${DSH_NPM_PKG} обновлён → ${r.version}; dsh стартует с новой версией`);
        return;
      }
      // npm отработал, но запускаемый dsh — прежний: npm ставит в другой
      // prefix (например, dsh из nvm, а npm — системный).
      console.error(`[launcher] npm install прошёл, но ${state.dshBin} — ${r.ok ? r.version : 'не запускается'} (prefix npm: ${npmInfo.prefix})`);
      updateState.mode = 'manual';
      updateState.manualCmd = cmdAuto;
      note = tr(`npm поставил пакет в ${npmInfo.prefix || 'свой prefix'}, но лаунчер запускает ${state.dshBin} (версия ${r.ok ? r.version : 'неизвестна'}). Обновите dsh тем npm, которым он был установлен, и нажмите «Проверить ещё раз».`,
                `npm installed the package into ${npmInfo.prefix || 'its prefix'}, but the launcher runs ${state.dshBin} (version ${r.ok ? r.version : 'unknown'}). Update dsh with the npm it was installed with and click "Check again".`);
      noteIsError = true;
      continue;
    }
    console.error(`[launcher] обновление dsh не удалось (код ${code})`);
    updateState.mode = 'manual';
    updateState.manualCmd = cmdAuto; // prefix доступен без sudo (canAuto) — sudo с nvm только навредит
    note = tr(`Установка не удалась (код ${code}). Повторите, либо выполните команду выше в терминале и нажмите «Проверить ещё раз».`,
              `Installation failed (code ${code}). Retry, or run the command above in a terminal and click "Check again".`);
    noteIsError = true;
  }
}

/* ---------------- меню окна: «О программе», «Проверить обновления» ---------------- */

// Строка меню сверху окна всегда видна (autoHideMenuBar: false):
//   «Файл»    — Перезапустить dsh…, Выйти (штатно, останавливает dsh);
//   «Правка»  — Вырезать / Копировать / Вставить / Выделить всё;
//   «Вид»     — перезагрузка, масштаб, поиск, орфография, полный экран;
//   «Справка» — Проверить обновления… (окно-диалог: сверяет GitHub и npm,
//               без авто-установки), Открыть папку логов, О программе
//               (окно-диалог: версии, пути, GPU; блок копируется для отчёта).
// Подписи следуют за языком окна — при переключении RU|EN меню собирается
// заново (onLangSwitch → buildAppMenu).

/* ===== appMenuTemplate (чистая функция, тест test/menu.js) =====
   Сочетания клавиш в меню — только подсказки (registerAccelerator: false):
   Ctrl+X/C/V/A Chromium обрабатывает сам, остальные — keyAction в
   before-input-event; перехват меню перебивал бы горячие клавиши GUI dsh.
   «Правка» — те же действия, что в контекстном меню, стандартными ролями
   (действуют на окно в фокусе — главное или диалог). */
function appMenuTemplate() {
  const hint = (key) => ({ accelerator: key, registerAccelerator: false });
  const edit = (role, ru, en, key) => ({ role, label: tr(ru, en), ...hint('CmdOrCtrl+' + key) });
  const view = (act, ru, en, key) => ({ label: tr(ru, en), click: () => viewActions[act](), ...hint(key) });
  // найдено обновление (периодическая проверка или «Проверить обновления…») —
  // пункт «Обновить … до X…» в «Справке»
  const upd = (kind, name) => (availableUpdates[kind] ? [{
    label: tr(`Обновить ${name} до ${availableUpdates[kind].version}…`, `Update ${name} to ${availableUpdates[kind].version}…`),
    click: () => showUpdateNowDialog(kind),
  }] : []);
  return [
    {
      label: tr('Файл', 'File'),
      submenu: [
        { label: tr('Настройки…', 'Settings…'), click: () => showSettingsDialog(), ...hint('CmdOrCtrl+,') },
        { type: 'separator' },
        { label: tr('Перезапустить dsh…', 'Restart dsh…'), click: () => { void restartDsh(); } },
        { type: 'separator' },
        { label: tr('Выйти', 'Quit'), role: 'quit' },
      ],
    },
    {
      label: tr('Правка', 'Edit'),
      submenu: [
        edit('cut', 'Вырезать', 'Cut', 'X'),
        edit('copy', 'Копировать', 'Copy', 'C'),
        edit('paste', 'Вставить', 'Paste', 'V'),
        { type: 'separator' },
        edit('selectAll', 'Выделить всё', 'Select all', 'A'),
      ],
    },
    {
      label: tr('Вид', 'View'),
      submenu: [
        view('reload', 'Перезагрузить', 'Reload', 'F5'),
        view('reloadHard', 'Перезагрузить без кэша', 'Reload ignoring cache', 'CmdOrCtrl+Shift+R'),
        { type: 'separator' },
        view('zoomIn', 'Увеличить', 'Zoom in', 'CmdOrCtrl+='),
        view('zoomOut', 'Уменьшить', 'Zoom out', 'CmdOrCtrl+-'),
        view('zoomReset', 'Обычный масштаб', 'Actual size', 'CmdOrCtrl+0'),
        { type: 'separator' },
        view('find', 'Найти на странице…', 'Find in page…', 'CmdOrCtrl+F'),
        { type: 'separator' },
        { label: tr('Проверка орфографии', 'Spell check'), type: 'checkbox', checked: spellcheckOn, click: (item) => setSpellcheck(item.checked) },
        view('fullscreen', 'Полноэкранный режим', 'Full screen', 'F11'),
      ],
    },
    {
      label: tr('Справка', 'Help'),
      submenu: [
        ...upd('launcher', 'DeepSeek Harness Launcher'),
        ...upd('dsh', 'dsh'),
        ...(availableUpdates.launcher || availableUpdates.dsh ? [{ type: 'separator' }] : []),
        { label: tr('Проверить обновления…', 'Check for updates…'), click: () => { void showUpdateCheckDialog(); } },
        { label: tr('Журнал dsh…', 'dsh log…'), click: () => showLogDialog() },
        { label: tr('Открыть папку логов', 'Open logs folder'), click: () => { void openLogsFolder(); } },
        { label: tr('Сохранить отчёт…', 'Save report…'), click: () => { void saveReport(); } },
        { type: 'separator' },
        { label: tr('О программе', 'About'), click: () => { void showAboutDialog(); } },
      ],
    },
  ];
}
/* ===== end appMenuTemplate ===== */

function buildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
  // На Linux setApplicationMenu ставит меню всем окнам — у окна-диалога его быть не должно.
  if (state.dialogWin && !state.dialogWin.isDestroyed()) state.dialogWin.setMenu(null);
  if (tray) tray.setContextMenu(trayMenu());
}



// Открытое контекстное меню — закрыть его по маршруту /menu/close-context/
// (Docker-сценарии: события CDP идут в страницу мимо нативного меню, и само
// оно в контейнере не закрывается).
let openContextMenu = null;

/* ===== showContextMenu (тест test/menu.js, с подставными win/Menu/clipboard) ===== */
function showContextMenu(params, w = state.win) {
  if (!w || w.isDestroyed()) return;
  const wc = w.webContents;
  const run = {
    cut: () => wc.cut(),
    copy: () => wc.copy(),
    paste: () => wc.paste(),
    selectAll: () => wc.selectAll(),
    copyLink: () => clipboard.writeText(params.linkURL),
    replace: (i) => wc.replaceMisspelling(i.value),
    addWord: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    none: () => {},
  };
  const items = contextMenuItems(params);
  // В лог — что показали (Docker-сценарий context_menu проверяет по нему:
  // кликнуть по нативному меню driver не может).
  console.log('[launcher] контекстное меню: ' +
    items.map((i) => (i.type ? '|' : i.label + (i.enabled ? '' : ' (off)'))).join(', '));
  const template = items.map((i) =>
    i.type ? i : { label: i.label, enabled: i.enabled, click: () => run[i.action](i) });
  const menu = Menu.buildFromTemplate(template);
  openContextMenu = menu;
  menu.once('menu-will-close', () => {
    if (openContextMenu === menu) openContextMenu = null;
    console.log('[launcher] контекстное меню закрыто');
  });
  menu.popup({ window: w });
}
/* ===== end showContextMenu ===== */

// Версия лаунчера: пакетная установка — dpkg; сборка из исходников —
// package.json (теперь синхронизирован с релизом, 1.2.0+).
async function launcherVersionRaw() {
  if (process.execPath.startsWith('/opt/dsh-launcher/')) return launcherInstalledVersion();
  try { return require('./package.json').version; } catch { return null; }
}

// Версия dsh: если DSH_BIN исполняется — спрашиваем её (--version), иначе —
// версия, найденная installCheck при старте.
// Версия dsh для окон («О программе», «Проверить обновления…») — без запуска
// dsh --version (см. launcherInstalledVersion): из package.json пакета
// @deepseek-ai/dsh, к которому ведёт программа dsh (ссылка → …/bin.js), иначе
// — проверенная при старте; и только если её нет — запуск dsh --version.
function dshPackageVersion(bin) {
  try {
    for (let d = path.dirname(fs.realpathSync(bin)); d !== path.dirname(d); d = path.dirname(d)) {
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { continue; }
      if (j && j.name === DSH_NPM_PKG && j.version) return String(j.version);
    }
  } catch { /* программы нет */ }
  return null;
}

async function dshVersionRaw() {
  const v = (state.dshBin && dshPackageVersion(state.dshBin)) || state.dshInstalledVersion;
  if (v) return v;
  if (state.dshBin) {
    const r = await probeDsh(state.dshBin);
    if (r.ok) return r.version;
  }
  return null;
}

/* ---------------- размер окна между запусками ---------------- */

// Запоминаем размер и «развёрнуто» (позицию не трогаем: на Wayland её
// выбирает композитор). Полноэкранный режим не сохраняем.
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')); } catch { return null; }
}



function trackWindowState(w) {
  // Последнее известное состояние — в памяти: при закрытии из страницы
  // (window.close()) Electron не шлёт 'close', и окно уже не спросить;
  // 'closed' же приходит всегда — тогда и пишем.
  let last = null;
  let timer = null;
  const snapshot = () => {
    if (w.isDestroyed() || w.isFullScreen()) return;
    const b = w.getNormalBounds(); // размер «не развёрнутого» окна
    last = { width: b.width, height: b.height, maximized: w.isMaximized() };
  };
  const write = () => {
    if (!last) return;
    try { fs.writeFileSync(windowStateFile(), JSON.stringify(last)); } catch { /* noop */ }
  };
  const later = () => { snapshot(); clearTimeout(timer); timer = setTimeout(write, 500); };
  w.once('ready-to-show', snapshot);
  w.once('show', snapshot); // Wayland: ready-to-show может не прийти — окно показывают по таймеру
  for (const ev of ['resize', 'maximize', 'unmaximize']) w.on(ev, later);
  w.on('close', snapshot); // крестик / «Выйти» — самые свежие размеры
  w.on('closed', () => { clearTimeout(timer); write(); });
}

/* ---------------- «Вид»: перезагрузка, масштаб, поиск, полный экран ---------------- */

// Действия доступны и из меню «Вид», и с клавиатуры (keyAction). Масштаб
// сохраняем в userData, чтобы не сбрасывался между запусками. (Ctrl+колесо
// не поддержано: в свежих Electron wheel-события в main-процесс приходят
// ненадёжно, а перехват колеса в самой странице конфликтует с её
// обработчиками.)
const zoomFile = () => path.join(app.getPath('userData'), 'zoom-level.json');
let zoomSaveTimer = null;

function applyZoom(level, note) {
  if (!state.win || state.win.isDestroyed()) return;
  const z = Math.max(-5, Math.min(5, level));
  state.win.webContents.setZoomLevel(z);
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(zoomFile(), JSON.stringify({ zoomLevel: z })); } catch { /* noop */ }
  }, 400);
  if (note) console.log(`[launcher] ${note}`);
}

const zoomOf = () => (state.win && !state.win.isDestroyed() ? state.win.webContents.getZoomLevel() : 0);
const viewActions = {
  reload: () => { state.win.webContents.reload(); console.log('[launcher] перезагрузка страницы'); },
  reloadHard: () => { state.win.webContents.reloadIgnoringCache(); console.log('[launcher] перезагрузка страницы без кэша'); },
  zoomIn: () => applyZoom(zoomOf() + 0.5),
  zoomOut: () => applyZoom(zoomOf() - 0.5),
  zoomReset: () => applyZoom(0, 'масштаб сброшен'),
  find: () => openFind(),
  findNext: () => findStep(true),
  findPrev: () => findStep(false),
  fullscreen: () => state.win.setFullScreen(!state.win.isFullScreen()),
  settings: () => showSettingsDialog(),
};



// Поиск по странице (Ctrl+F): панель в правом верхнем углу окна — отдельный
// WebContentsView поверх страницы (не окно: на Wayland его не поставить в
// нужное место). Панель — data:-страница; ввод и кнопки — переходы на
// dshlauncher://find/… (ответ 204: панель остаётся как есть, фокус в поле).
// Счётчик «N из M» — по событию found-in-page главного окна.
const FIND_W = 430;
const FIND_H = 46;
let findView = null;
let findText = '';

function findBarUrl() {
  const css = `html,body{margin:0;height:100%;background:#151a23;color:#d7dce3;overflow:hidden;
    font:13px system-ui,'Segoe UI',Roboto,Ubuntu,sans-serif}
    body{display:flex;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;
    border:1px solid #2a3550;border-radius:10px}
    input{flex:1;min-width:0;background:#0f1115;border:1px solid #2a3550;border-radius:7px;color:#e6ebf4;
    padding:6px 9px;font-size:13px}
    input:focus{outline:none;border-color:#3b82f6}
    #n{min-width:64px;text-align:center;color:#9aa4b2;font-variant-numeric:tabular-nums}
    button{background:#1f2836;border:0;border-radius:7px;color:#d7dce3;width:28px;height:28px;cursor:pointer;font-size:14px}
    button:hover{background:#2a3550}`;
  const go = (r) => `location.href='dshlauncher://find/${r}/'`;
  const html = `<!doctype html><html lang="${UI_LANG}"><head><meta charset="utf-8"><style>${css}</style></head><body>
    <input id="q" placeholder="${esc(tr('Найти на странице', 'Find in page'))}" spellcheck="false" autocomplete="off">
    <span id="n"></span>
    <button title="${esc(tr('Предыдущее (Shift+Enter)', 'Previous (Shift+Enter)'))}" onclick="${go('prev')}">&#8593;</button>
    <button title="${esc(tr('Следующее (Enter)', 'Next (Enter)'))}" onclick="${go('next')}">&#8595;</button>
    <button title="${esc(tr('Закрыть (Esc)', 'Close (Esc)'))}" onclick="${go('close')}">&#10005;</button>
    <script>
      const q = document.getElementById('q');
      q.addEventListener('input', () => { location.href = 'dshlauncher://find/q/?t=' + encodeURIComponent(q.value); });
      q.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); ${go("' + (e.shiftKey ? 'prev' : 'next') + '")}; }
        else if (e.key === 'Escape') { e.preventDefault(); ${go('close')}; }
      });
      window.setCount = (t) => { document.getElementById('n').textContent = t; };
    </script></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function placeFind() {
  if (!findView || !state.win || state.win.isDestroyed()) return;
  const [cw] = state.win.getContentSize();
  findView.setBounds({ x: Math.max(0, cw - FIND_W - 18), y: 10, width: Math.min(FIND_W, cw), height: FIND_H });
}

function setFindCount(text) {
  if (!findView) return;
  findView.webContents.executeJavaScript(`window.setCount && setCount(${JSON.stringify(text)})`).catch(() => {});
}

function openFind() {
  if (!state.win || state.win.isDestroyed() || state.stopping) return;
  if (!findView) {
    findView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false } });
    findView.setBackgroundColor('#00000000');
    findView.webContents.loadURL(findBarUrl()).catch(() => {});
    state.win.contentView.addChildView(findView);
    state.win.on('resize', placeFind);
    state.win.webContents.on('found-in-page', (_e, r) => {
      if (r.finalUpdate) setFindCount(r.matches ? `${r.activeMatchOrdinal} / ${r.matches}` : tr('нет', 'none'));
    });
    // Ушли на другую страницу — старые совпадения неактуальны.
    state.win.webContents.on('did-navigate', () => { if (findText) { findText = ''; closeFind(); } });
  }
  placeFind();
  findView.setVisible(true);
  placeToast();
  findView.webContents.focus();
  findView.webContents.executeJavaScript("document.getElementById('q') && document.getElementById('q').select()").catch(() => {});
}

function findQuery(text) {
  if (!state.win || state.win.isDestroyed()) return;
  findText = text;
  if (!text) { state.win.webContents.stopFindInPage('clearSelection'); setFindCount(''); return; }
  state.win.webContents.findInPage(text, { findNext: true });
}

function findStep(forward) {
  if (!findView || !findView.getVisible()) return openFind();
  if (findText) state.win.webContents.findInPage(findText, { forward, findNext: false });
}

function closeFind() {
  if (!findView || !state.win || state.win.isDestroyed()) return;
  state.win.webContents.stopFindInPage('keepSelection');
  findView.setVisible(false);
  placeToast();
  state.win.webContents.focus();
}

function onFindRequest(route, url) {
  if (route.startsWith('/find/q/')) findQuery(new URL(url).searchParams.get('t') || '');
  else if (route.startsWith('/find/next/')) findStep(true);
  else if (route.startsWith('/find/prev/')) findStep(false);
  else if (route.startsWith('/find/close/')) closeFind();
  return noContentResponse();
}

// Проверка орфографии в полях ввода (русский и английский). Словари
// Chromium на Linux скачивает при первом включении (с серверов Google); без
// сети проверка просто не работает. Вкл/выкл — меню «Вид», запоминается.
const spellFile = () => path.join(app.getPath('userData'), 'spellcheck.json');
let spellcheckOn = true;

function initSpellcheck() {
  try { spellcheckOn = JSON.parse(fs.readFileSync(spellFile(), 'utf8')).enabled !== false; } catch { /* по умолчанию вкл */ }
  const ses = session.defaultSession;
  const langs = ['ru', 'en-US'].filter((l) => ses.availableSpellCheckerLanguages.includes(l));
  if (langs.length) ses.setSpellCheckerLanguages(langs);
  ses.setSpellCheckerEnabled(spellcheckOn);
}

function setSpellcheck(on) {
  spellcheckOn = on;
  session.defaultSession.setSpellCheckerEnabled(on);
  try { fs.writeFileSync(spellFile(), JSON.stringify({ enabled: on })); } catch { /* noop */ }
  console.log(`[launcher] проверка орфографии: ${on ? 'вкл' : 'выкл'}`);
  buildAppMenu(); // галочка в «Виде»
}

/* ---------------- «Файл» / «Справка»: перезапуск dsh, папка логов ---------------- */

async function openLogsFolder() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* noop */ }
  const err = await shell.openPath(LOG_DIR);
  if (err) console.error('[launcher] не удалось открыть папку логов:', err);
}

// «Перезапустить dsh» (например, после обновления плагинов): останавливаем
// dsh, который запустил лаунчер, и запускаем заново — без вопросов об
// обновлениях. dsh, к которому лаунчер лишь подключился (запущен в
// терминале), не трогаем — у него свой хозяин.
let restartingDsh = false;

async function restartDsh({ confirm = true } = {}) {
  if (!state.win || state.win.isDestroyed() || state.stopping || state.launching || restartingDsh) return;
  if (!state.weStartedDsh && !state.adoptedDsh) {
    await dialog.showMessageBox(state.win, {
      type: 'info',
      title: tr('Перезапуск dsh', 'Restart dsh'),
      message: tr('Этот dsh запущен не лаунчером', 'This dsh was not started by the launcher'),
      detail: tr('Лаунчер подключился к уже работавшему dsh — перезапустите его там, где запускали (например, в терминале).',
        'The launcher attached to a dsh that was already running — restart it where it was started (e.g. in a terminal).'),
    });
    return;
  }
  if (confirm) {
    const { response } = await dialog.showMessageBox(state.win, {
      type: 'question',
      buttons: [tr('Перезапустить', 'Restart'), tr('Отмена', 'Cancel')],
      defaultId: 0,
      cancelId: 1,
      title: tr('Перезапуск dsh', 'Restart dsh'),
      message: tr('Перезапустить dsh?', 'Restart dsh?'),
      detail: tr('Текущий ответ агента прервётся; сессии сохранятся.', 'The current agent reply will be interrupted; sessions are kept.'),
    });
    if (response !== 0) return;
  }
  console.log('[launcher] перезапуск dsh по запросу');
  restartingDsh = true;
  state.launching = true; // watchdog не трогает окно, пока порт падает и поднимается
  try {
    showPage(() => showStatus(tr('Перезапуск dsh…', 'Restarting dsh…'),
      tr('<p>Останавливаю <code>dsh</code> и запускаю заново…</p>', '<p>Stopping <code>dsh</code> and starting it again…</p>'), false));
    if (state.adoptedDsh) await stopAdoptedDsh(); else await stopDsh();
    for (let i = 0; i < 50 && await portOpen(); i++) await sleep(100); // порт освободился
    state.weStartedDsh = false; state.adoptedDsh = false; state.adoptedOldPgid = null; state.dshProc = null; state.dshFatal = false;
  } finally {
    restartingDsh = false;
    state.launching = false;
  }
  await launchDshInner();
}



function gpuStatusNow() {
  let markerAgeMs = null;
  try { markerAgeMs = Date.now() - fs.statSync(GPU_MARKER_FILE).mtimeMs; } catch { /* маркера нет */ }
  return gpuStatus({
    noGpuRequested, noGpuBySettings: CONFIG.src.gpu === 'settings', disabledByMarker: gpuDisabledByMarker, hasRenderNode: hasGpuRenderNode, hasEgl: hasEglLibs,
    markerAgeMs, ttlMs: GPU_MARKER_TTL_MS,
  });
}

function gpuStatusText(g) {
  if (g.on) {
    return g.marker
      ? tr('включено; со следующего запуска будет отключено — GPU-процесс падал', 'on; will be off from the next start — the GPU process crashed')
      : tr('включено', 'on');
  }
  if (g.reason === 'env') return tr('отключено (DSH_LAUNCHER_NO_GPU=1)', 'off (DSH_LAUNCHER_NO_GPU=1)');
  if (g.reason === 'setting') return tr('отключено в «Настройках»', 'off in Settings');
  if (g.reason === 'marker') {
    return g.marker
      ? tr(`отключено после сбоев GPU-процесса (ещё ${g.daysLeft} дн.)`, `off after GPU process crashes (${g.daysLeft} more days)`)
      : tr('отключено до перезапуска лаунчера (включится при следующем запуске)', 'off until the launcher restarts (on from the next start)');
  }
  if (g.reason === 'norender') return tr('отключено (нет /dev/dri/renderD* — ВМ без 3D?)', 'off (no /dev/dri/renderD* — a VM without 3D?)');
  return tr('отключено (нет библиотек EGL)', 'off (no EGL libraries)');
}

function onDialogGpuEnable() {
  try { fs.unlinkSync(GPU_MARKER_FILE); console.log('[launcher] маркер сбоев GPU снят — GPU со следующего запуска'); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[launcher] маркер GPU:', e.message); }
  if (state.dialogRender) state.dialogRender(false);
  return noContentResponse();
}

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
  const gen = openDialog(title);
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
        ${dialogCloseButton()}
      </div>
      <script>const l = document.querySelector('pre.log'); if (l) l.scrollTop = l.scrollHeight;</script>`;
    dialogPage(title, body);
  };
  dialogShow(gen, render);
}

/* ---------------- «Что нового» после обновления ---------------- */

// Версия, с которой лаунчер запускался в прошлый раз. Стала выше — после
// загрузки GUI один раз показываем изменения между ними. Первый запуск —
// просто запоминаем. Нет ответа GitHub — версию не запоминаем: покажем при
// следующем запуске.
const lastVersionFile = () => path.join(app.getPath('userData'), 'last-version.json');
let whatsNewChecked = false;



function saveLastVersion(v) {
  // подставная «установленная» версия (разработка/тесты) — не настоящая:
  // не запоминать, иначе «Что нового» потом назовёт её прежней версией
  if (process.env.DSH_LAUNCHER_FAKE_INSTALLED) return;
  try {
    fs.mkdirSync(path.dirname(lastVersionFile()), { recursive: true });
    fs.writeFileSync(lastVersionFile(), JSON.stringify({ version: v }));
  } catch (e) { console.error('[launcher] last-version.json:', e.message); }
}

async function maybeShowWhatsNew() {
  if (whatsNewChecked) return;
  whatsNewChecked = true;
  const current = await launcherVersionRaw();
  if (!current) return;
  let last = null;
  try { last = JSON.parse(fs.readFileSync(lastVersionFile(), 'utf8')).version || null; } catch { /* первый запуск */ }
  const scheme = process.execPath.startsWith('/opt/dsh-launcher/') ? 'deb' : 'semver';
  if (!shouldShowWhatsNew(last, current, scheme)) { saveLastVersion(current); return; }
  if (NO_UPDATE_CHECK) { saveLastVersion(current); return; } // в сеть ходить нельзя — молча
  let latest = await updateChecks.launcher;
  // Список релизов из кэша (до часа) мог быть получен до выхода этой версии
  // (например, пакет поставили через apt) — тогда её описания в нём нет:
  // запросить заново, мимо кэша.
  const hasCurrent = (l) => l && Array.isArray(l.releases) && l.releases.some((r) =>
    (scheme === 'deb' ? tagToPackageVersion(r.version) : r.version) === current);
  if (latest && !hasCurrent(latest)) {
    console.log(`[launcher] в кэше релизов нет ${current} — запрашиваю список заново`);
    latest = (await timedCheck(fetchLauncherLatest({ force: true }), UPDATE_CHECK_TIMEOUT)) || latest;
  }
  if (!latest || !latest.releases) return; // нет ответа GitHub — покажем в следующий раз
  const items = notesBetween(latest.releases, last, current, scheme);
  console.log(`[launcher] обновлён ${last} → ${current} — показываю «Что нового» (${items.length})`);
  saveLastVersion(current);
  const title = tr('Что нового', 'What’s new');
  const gen = openDialog(title);
  if (gen === null) return;
  state.dialogCopyText = '';
  const link = `https://github.com/${UPDATE_GITHUB_REPO}/releases`;
  dialogShow(gen, () => dialogPage(title, `
    <p style="margin:0 0 4px">${tr('DeepSeek Harness Launcher обновлён:', 'DeepSeek Harness Launcher was updated:')} <code>${esc(last)}</code> → <code>${esc(current)}</code></p>
    ${notesBlockHtml(items) || `<p>${tr('Подробности — на', 'Details are on the')} <a href="${esc(link)}" target="_blank">${tr('странице релизов', 'releases page')}</a>.</p>`}
    <div class="actions">${dialogCloseButton()}</div>`));
}

/* ---------------- окно «Настройки» ---------------- */

// «Файл → Настройки…» (Ctrl+,). Каждое поле сохраняется сразу (переход на
// dshlauncher://settings/set/?k=…&v=…, ответ 204); язык, орфография, маркет,
// «снова спрашивать» действуют сразу, проверка обновлений — со следующего
// запуска, остальное — после перезапуска лаунчера (кнопка в окне).



function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === '') delete next[k];
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

function setLanguage(lang) {
  if (lang === 'auto') {
    try { fs.rmSync(langPrefFile(), { force: true }); } catch { /* noop */ }
    UI_LANG = /^ru/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '') ? 'ru' : 'en'; i18n.setLang(UI_LANG);
    buildAppMenu();
    if (state.currentPage) state.currentPage();
  } else {
    onLangSwitch(lang);
  }
}

function langSetting() {
  try { JSON.parse(fs.readFileSync(langPrefFile(), 'utf8')); return UI_LANG; } catch { return 'auto'; }
}

function updateDismissals() {
  const p = updatePrefs();
  return Object.keys(p).filter((k) => p[k]).map((k) => `${k === 'launcher' ? 'DeepSeek Harness Launcher' : 'dsh'} ${p[k]}`);
}

let settingsNote = null; // { text, error }

function onSettingsSet(url) {
  const q = new URL(url).searchParams;
  const key = q.get('k');
  const r = settingValue(key, q.get('v'));
  if (r.error) {
    settingsNote = { text: r.error, error: true };
  } else {
    try {
      if (key === 'lang') setLanguage(r.value);
      else if (key === 'spellcheck') setSpellcheck(r.value);
      else if (key === 'gpu' || key === 'ozone') saveSettings({ [key]: r.value === 'auto' ? null : r.value });
      else if (key === 'port') saveSettings({ port: r.value === DEFAULT_PORT ? null : r.value });
      else if (key === 'profile') saveSettings({ profile: r.value === DEFAULT_PROFILE ? null : r.value });
      else if (key === 'checkUpdates') saveSettings({ checkUpdates: r.value ? null : false });
      else if (key === 'pollUpdates') { saveSettings({ pollUpdates: r.value ? null : false }); setUpdatePolling(r.value); }
      else if (key === 'closeToTray') { saveSettings({ closeToTray: r.value ? true : null }); setTray(r.value); }
      else if (key === 'attention') saveSettings({ attention: r.value ? null : false });
      else if (key === 'attentionSound') { saveSettings({ attentionSound: r.value ? true : null }); if (r.value && state.win) playAgentSound(); } // сразу — услышать
      else saveSettings({ [key]: r.value || null }); // dshPath, cwd: '' — по умолчанию
      console.log(`[launcher] настройки: ${key} = ${key === 'dshPath' || key === 'cwd' ? (r.value || '(по умолчанию)') : r.value}`);
      settingsNote = { text: tr('Сохранено', 'Saved'), error: false };
    } catch (e) {
      settingsNote = { text: e.message, error: true };
    }
  }
  if (state.dialogRender) state.dialogRender(false);
  return noContentResponse();
}

async function onSettingsPick(kind) {
  if (!state.dialogWin || state.dialogWin.isDestroyed()) return noContentResponse();
  const isDir = kind === 'cwd';
  const r = await dialog.showOpenDialog(state.dialogWin, {
    title: isDir ? tr('Рабочая папка dsh', 'dsh working folder') : tr('Программа dsh', 'The dsh program'),
    defaultPath: isDir ? CWD : path.dirname(state.dshBin),
    properties: isDir ? ['openDirectory'] : ['openFile'],
  });
  if (!r.canceled && r.filePaths[0]) {
    return onSettingsSet(`dshlauncher://settings/set/?k=${kind}&v=${encodeURIComponent(r.filePaths[0])}`);
  }
  return noContentResponse();
}

function onSettingsResetUpdates() {
  try { fs.writeFileSync(updatePrefFile(), '{}'); } catch { /* noop */ }
  console.log('[launcher] настройки: снова спрашивать об обновлениях');
  settingsNote = { text: tr('Об отложенных обновлениях лаунчер снова спросит при запуске.', 'The launcher will ask about postponed updates again at startup.'), error: false };
  if (state.dialogRender) state.dialogRender(false);
  return noContentResponse();
}

// Перезапуск лаунчера (применить настройки). Не app.relaunch(): Electron
// запускает новый экземпляр, пока старый ещё держит блокировку «один
// экземпляр», и новый тут же закрывается. Поэтому так: before-quit
// останавливает dsh, затем (relaunchRequested) старый отпускает блокировку
// и запускает новый экземпляр через sh, который ждёт, пока старый выйдет
// совсем (не дольше 20 с): иначе экземпляры перекрываются — новый не может
// занять то, что ещё держит старый (порт отладки, файлы Chromium).
state.relaunchRequested = false;

function relaunchLauncher(why = 'чтобы применить настройки') {
  if (state.relaunchRequested || state.stopping) return;
  console.log(`[launcher] перезапуск лаунчера, ${why}`);
  state.relaunchRequested = true;
  app.quit();
}

// Новый экземпляр лаунчера — отдельно от этого, через bash: закрыть
// унаследованные дескрипторы (CLOSE_INHERITED_FDS), дождаться, пока этот
// процесс выйдет (до 20 с), и exec — тот же pid.
// $0 — pid этого процесса, "$@" — команда нового экземпляра.
function spawnLauncherAfterExit(cmd, args, stdio) {
  const script = CLOSE_INHERITED_FDS +
    'i=0; while kill -0 "$0" 2>/dev/null && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done; exec "$@"';
  return spawn('/bin/bash', ['-c', script, String(process.pid), cmd, ...args], { detached: true, stdio, env: process.env });
}

function spawnNewInstance() {
  app.releaseSingleInstanceLock();
  // stdout/stderr — те же: вывод нового экземпляра идёт туда же, что и прежнего
  const p = spawnLauncherAfterExit(process.execPath, process.argv.slice(1), ['ignore', 'inherit', 'inherit']);
  p.unref();
  console.log(`[launcher] новый экземпляр (pid ${p.pid}) запустится, когда этот завершится`);
}

// Раздел окна «Настройки» (меню слева) — запоминается, пока лаунчер открыт.
const SETTINGS_SECTIONS = ['general', 'updates', 'dsh', 'window', 'graphics'];
let settingsSection = 'general';

function showSettingsDialog() {
  const title = tr('Настройки', 'Settings');
  const gen = openDialog(title);
  if (gen === null) return;
  settingsNote = null;
  state.dialogCopyText = '';
  const render = () => {
    const next = effectiveConfig(process.env, loadSettings(), os.homedir());
    const pending = restartNeeded(CONFIG, next);
    const envNote = (key, name) => (next.src[key] === 'env'
      ? `<span class="hint">${tr('задано переменной', 'set by')} <code>${name}</code></span>` : '');
    const locked = (key) => (next.src[key] === 'env' ? ' disabled' : '');
    const sel = (key, value, options) => `<select id="${key}" onchange="set('${key}', this.value)"${locked(key)}>${
      options.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    const check = (key, on, label, disabled = false) =>
      `<label class="chk"><input type="checkbox" id="${key}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}
        onchange="set('${key}', this.checked)"> ${esc(label)}</label>`;
    const dismissed = updateDismissals();
    const gpu = gpuStatusNow();
    const dshShown = next.dshBin || tr(`автоматически (сейчас: ${state.dshBin})`, `automatic (now: ${state.dshBin})`);
    const body = `
      ${pending.length ? `<div class="banner">${tr('Изменения вступят в силу после перезапуска лаунчера.', 'Changes take effect after the launcher restarts.')}
        <button onclick="go('relaunch')">${tr('Перезапустить лаунчер', 'Restart the launcher')}</button></div>` : ''}
      ${settingsNote ? `<p class="${settingsNote.error ? 'pop err' : 'pop'}" role="status">${esc(settingsNote.text)}</p>` : ''}
      <div class="sett">
        <nav>
          <a data-s="general" class="${settingsSection === 'general' ? 'on' : ''}" onclick="sec('general')">${tr('Общие', 'General')}</a>
          <a data-s="updates" class="${settingsSection === 'updates' ? 'on' : ''}" onclick="sec('updates')">${tr('Обновления', 'Updates')}</a>
          <a data-s="dsh" class="${settingsSection === 'dsh' ? 'on' : ''}" onclick="sec('dsh')">${tr('Запуск dsh', 'Starting dsh')}</a>
          <a data-s="window" class="${settingsSection === 'window' ? 'on' : ''}" onclick="sec('window')">${tr('Окно', 'Window')}</a>
          <a data-s="graphics" class="${settingsSection === 'graphics' ? 'on' : ''}" onclick="sec('graphics')">${tr('Графика', 'Graphics')}</a>
        </nav>
        <div class="panes">
          <section id="sec-general" class="form"${settingsSection === 'general' ? '' : ' hidden'}>
        <div class="row"><span>${tr('Язык интерфейса', 'Interface language')}</span>
          ${LANG_FORCED ? `<code>${UI_LANG}</code> <span class="hint">${tr('задано переменной', 'set by')} <code>DSH_LAUNCHER_LANG</code></span>`
            : sel('lang', langSetting(), [['auto', tr('Авто (как в системе)', 'Auto (system)')], ['ru', 'Русский'], ['en', 'English']])}</div>
        <div class="row">${check('spellcheck', spellcheckOn, tr('Проверка орфографии в полях ввода', 'Spell check in text fields'))}</div>
          </section>
          <section id="sec-updates" class="form"${settingsSection === 'updates' ? '' : ' hidden'}>
        <div class="row">${check('checkUpdates', next.checkUpdates, tr('Проверять обновления при запуске (со следующего запуска)', 'Check for updates at startup (from the next start)'), next.src.checkUpdates === 'env')}
          ${envNote('checkUpdates', 'DSH_LAUNCHER_NO_UPDATE_CHECK')}</div>
        <div class="row">${check('pollUpdates', next.pollUpdates, tr('Проверять обновления раз в 12 часов, пока лаунчер открыт', 'Check for updates every 12 hours while the launcher is open'), next.src.pollUpdates === 'env')}
          ${envNote('pollUpdates', 'DSH_LAUNCHER_NO_UPDATE_CHECK')}</div>
        <div class="row"><span>${dismissed.length ? tr('Не спрашивать: ', 'Don’t ask: ') + esc(dismissed.join(', ')) : tr('Отложенных обновлений нет', 'No postponed updates')}</span>
          ${dismissed.length ? `<button onclick="go('reset-updates')">${tr('Снова спрашивать', 'Ask again')}</button>` : ''}</div>
          </section>
          <section id="sec-dsh" class="form"${settingsSection === 'dsh' ? '' : ' hidden'}>
        <div class="row"><span>${tr('Программа dsh', 'dsh program')}</span> <code class="val">${esc(dshShown)}</code>
          ${next.src.dshPath === 'env' ? envNote('dshPath', 'DSH_BIN')
            : `<button onclick="go('pick-dsh')">${tr('Выбрать…', 'Choose…')}</button>${next.dshBin ? ` <button onclick="set('dshPath', '')">${tr('Авто', 'Auto')}</button>` : ''}`}</div>
        <div class="row"><span>${tr('Профиль', 'Profile')}</span>
          <input id="profile" value="${esc(next.src.profile === 'env' ? (profileFromArgs(next.args) || '') : next.profile)}" onchange="set('profile', this.value)"${locked('profile')}>
          ${envNote('profile', 'DSH_ARGS')}</div>
        <div class="row"><span>${tr('Рабочая папка', 'Working folder')}</span> <code class="val">${esc(next.cwd)}</code>
          ${next.src.cwd === 'env' ? envNote('cwd', 'DSH_CWD')
            : `<button onclick="go('pick-cwd')">${tr('Выбрать…', 'Choose…')}</button>${next.src.cwd === 'settings' ? ` <button onclick="set('cwd', '')">${tr('Домашняя', 'Home')}</button>` : ''}`}</div>
        <div class="row"><span>${tr('Порт', 'Port')}</span>
          <input id="port" type="number" min="1024" max="65535" value="${next.port}" onchange="set('port', this.value)"${locked('port')}>
          ${envNote('port', 'DSH_PORT')}</div>
          </section>
          <section id="sec-window" class="form"${settingsSection === 'window' ? '' : ' hidden'}>
        <div class="row">${check('closeToTray', closeToTrayOn(), tr('Крестик прячет окно в трей — dsh работает дальше', 'The close button hides the window to the tray — dsh keeps running'))}</div>
        <p class="hint">${tr('Нужен трей на рабочем столе (в GNOME — расширение AppIndicator, в Ubuntu оно есть). Спрятанное окно вернёт и повторный запуск лаунчера.',
                             'Needs a system tray on the desktop (in GNOME — the AppIndicator extension, included in Ubuntu). Starting the launcher again also brings the hidden window back.')}</p>
        <div class="row">${check('attention', attentionOn(), tr('Сообщать, когда агент закончил ответ, а окно не в фокусе (уведомление, точка на значке трея)', 'Tell me when the agent finishes and the window is not focused (a notification, a dot on the tray icon)'))}</div>
        <div class="row">${check('attentionSound', attentionSoundOn(), tr('…и звуком', '…and with a sound'))}</div>
          </section>
          <section id="sec-graphics" class="form"${settingsSection === 'graphics' ? '' : ' hidden'}>
        <div class="row"><span>${tr('GPU-ускорение', 'GPU acceleration')}</span>
          ${sel('gpu', next.noGpu ? 'off' : 'auto', [['auto', tr('Авто', 'Auto')], ['off', tr('Выключено', 'Off')]])}
          ${envNote('gpu', 'DSH_LAUNCHER_NO_GPU')}</div>
        <div class="row"><span class="hint">${tr('Сейчас:', 'Now:')} ${esc(gpuStatusText(gpu))}</span>
          ${gpu.marker ? `<button onclick="location.href='dshlauncher://dialog/gpu-enable/'">${tr('Включить GPU снова', 'Re-enable GPU')}</button>` : ''}</div>
        <div class="row"><span>${tr('Окно на Wayland', 'Window on Wayland')}</span>
          ${sel('ozone', next.ozone, [['auto', tr('Авто', 'Auto')], ['wayland', 'Wayland'], ['x11', tr('X11 (XWayland) — если окна не видно', 'X11 (XWayland) — if the window is invisible')]])}
          ${envNote('ozone', 'DSH_LAUNCHER_OZONE')}</div>
          </section>
        </div>
      </div>
      <div class="actions">${dialogCloseButton()}</div>
      <script>
        function set(k, v) { location.href = 'dshlauncher://settings/set/?k=' + encodeURIComponent(k) + '&v=' + encodeURIComponent(v); }
        function go(r) { location.href = 'dshlauncher://settings/' + r + '/'; }
        // раздел — сразу на странице; лаунчер запоминает его для перерисовок
        function sec(id) {
          for (const el of document.querySelectorAll('.sett section')) el.hidden = el.id !== 'sec-' + id;
          for (const a of document.querySelectorAll('.sett nav a')) a.className = a.dataset.s === id ? 'on' : '';
          location.href = 'dshlauncher://settings/section/?s=' + id;
        }
      </script>`;
    dialogPage(title, body);
  };
  dialogShow(gen, render);
}

/* ---------------- окно-диалог: «О программе», «Проверить обновления» ---------------- */

// Небольшое модальное окно поверх основного. GUI dsh под ним никуда не
// уходит — не перезагружается и не теряет состояние. Одно окно на оба
// пункта: повторный вызов меняет содержимое. Закрыть — кнопкой, Esc или
// крестиком окна. Кнопки — переходы на dshlauncher://dialog/… (ответ 204:
// страница остаётся, обработчик делает своё).
state.dialogWin = null;
state.dialogRender = null; // перерисовка текущего содержимого: (copied) => void
let dialogGen = 0;       // поколение: поздний async-результат не попадёт в закрытый или сменившийся диалог
state.dialogCopyText = '';
let dimKey = null;       // ключ insertCSS затемнения главного окна

// Затемнение содержимого главного окна, пока открыт диалог: слой поверх
// страницы (только CSS, разметку GUI dsh не трогаем). Клики под ним и так
// не проходят — диалог модальный.
const DIM_CSS = `
  @keyframes dshl-dim { from { opacity: 0 } to { opacity: 1 } }
  html::after { content: ''; position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0, 0, 0, 0.55); pointer-events: none;
    animation: dshl-dim .15s ease-out; }`;

async function dimMain(on) {
  if (!state.win || state.win.isDestroyed() || state.win.webContents.isDestroyed() || state.stopping) return;
  const wc = state.win.webContents;
  try {
    if (on && !dimKey) dimKey = await wc.insertCSS(DIM_CSS);
    else if (!on && dimKey) { const k = dimKey; dimKey = null; await wc.removeInsertedCSS(k); }
  } catch (e) { console.error('[launcher] затемнение:', e.message); }
}

// Открыть диалог (или переиспользовать открытый) — поколение нового содержимого,
// null — окна нет / идёт выход.
function openDialog(title) {
  if (!state.win || state.win.isDestroyed() || state.stopping) return null;
  dialogGen++;
  if (state.dialogWin && !state.dialogWin.isDestroyed()) { state.dialogWin.focus(); return dialogGen; }
  const d = new BrowserWindow({
    parent: state.win,
    modal: true,
    width: 760,
    height: 580,
    minWidth: 520,
    minHeight: 360,
    resizable: true, // длинный «Что нового» можно растянуть
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title,
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  state.dialogWin = d;
  d.setMenu(null);
  d.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  d.webContents.on('context-menu', (_e, params) => showContextMenu(params, d));
  d.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); d.close(); }
  });
  void dimMain(true);
  d.once('ready-to-show', () => d.show());
  // Wayland: ready-to-show может опоздать (как у главного окна) — показываем сами.
  setTimeout(() => { if (!d.isDestroyed() && !d.isVisible()) d.show(); }, 3000);
  d.on('closed', () => {
    if (state.dialogWin === d) { state.dialogWin = null; state.dialogRender = null; dialogGen++; }
    void dimMain(false);
  });
  return dialogGen;
}

// Показать содержимое, если диалог того же поколения ещё открыт.
function dialogShow(gen, render) {
  if (gen !== dialogGen || !state.dialogWin || state.dialogWin.isDestroyed()) return;
  state.dialogRender = render;
  render(false);
}

function dialogPage(title, body) {
  if (!state.dialogWin || state.dialogWin.isDestroyed()) return;
  state.dialogWin.loadURL(pageHtml(title, body, false, { dialog: true }))
    .catch((e) => { if (e.code !== 'ERR_ABORTED') console.error('[launcher] диалог:', e.message); });
}

const dialogCloseButton = () =>
  `<button onclick="location.href='dshlauncher://dialog/close/'">${tr('Закрыть', 'Close')}</button>`;

function onDialogClose() {
  if (state.dialogWin && !state.dialogWin.isDestroyed()) state.dialogWin.close();
  return noContentResponse();
}

function onDialogCopy() {
  if (state.dialogCopyText) clipboard.writeText(state.dialogCopyText);
  if (state.dialogRender) state.dialogRender(true); // перерисовка: «Скопировано»
  return noContentResponse();
}

async function showAboutDialog() {
  const title = tr('О программе', 'About');
  const gen = openDialog(title);
  if (gen === null) return;
  const ver = { lver: null, dver: null, loaded: false };
  const render = (copied) => {
    const gpu = gpuStatusNow();
    const fromSrc = !process.execPath.startsWith('/opt/dsh-launcher/');
    const lLabel = fromSrc ? tr(' (сборка из исходников)', ' (built from source)') : '';
    const lDisp = ver.loaded ? (ver.lver || tr('неизвестно', 'unknown')) : tr('загружаю…', 'loading…');
    const dDisp = ver.loaded ? (ver.dver || tr('не установлен', 'not installed')) : tr('загружаю…', 'loading…');
    const rows = [
      ['DeepSeek Harness Launcher', lDisp + lLabel],
      [tr('бэкенд dsh', 'dsh backend'), dDisp],
      [tr('путь к dsh', 'path to dsh'), state.dshBin || '—'],
      ['Node.js', 'v' + process.versions.node],
      [tr('ОС', 'OS'), os.platform() + ' ' + os.release() + ' (' + os.arch() + ')'],
      [tr('GPU-ускорение', 'GPU acceleration'), gpuStatusText(gpu)],
      [tr('логи', 'logs'), LOG_DIR],
    ];
    state.dialogCopyText = ver.loaded ? rows.map(([k, v]) => k + ': ' + v).join('\n') : '';
    const body = `
      <table style="border-collapse:collapse; margin-bottom:4px">
        ${rows.map(([k, v]) =>
          '<tr><td style="padding:3px 14px 3px 0; color:#9aa4b2; white-space:nowrap">' + esc(k) + '</td>' +
          '<td style="padding:3px 0"><code>' + esc(v) + '</code></td></tr>').join('')}
      </table>
      <p style="margin-top:10px">
        <a href="https://github.com/Toximiner/DSH-Launcher" target="_blank">${tr('Репозиторий лаунчера (GitHub)', 'Launcher repository (GitHub)')}</a> ·
        <a href="https://www.npmjs.com/package/@deepseek-ai/dsh" target="_blank">@deepseek-ai/dsh</a>
      </p>
      <div class="actions">
        ${ver.loaded ? '<button onclick="location.href=\'dshlauncher://dialog/copy/\'">' + (copied ? tr('Скопировано', 'Copied') : tr('Скопировать для отчёта', 'Copy for report')) + '</button>' : ''}
        <button onclick="location.href='dshlauncher://dialog/logs/'">${tr('Папка логов', 'Logs folder')}</button>
        <button onclick="location.href='dshlauncher://menu/report/'">${tr('Сохранить отчёт…', 'Save report…')}</button>
        ${gpu.marker ? '<button onclick="location.href=\'dshlauncher://dialog/gpu-enable/\'">' + tr('Включить GPU снова', 'Re-enable GPU') + '</button>' : ''}
        ${dialogCloseButton()}
      </div>`;
    dialogPage(title, body);
  };
  dialogShow(gen, render);
  // Версии подставим, когда придут (dsh --version может занять до 8 с)
  const [lver, dver] = await Promise.all([launcherVersionRaw(), dshVersionRaw()]);
  Object.assign(ver, { lver, dver, loaded: true });
  dialogShow(gen, render);
}

async function showUpdateCheckDialog() {
  const title = tr('Проверка обновлений', 'Update check');
  const gen = openDialog(title);
  if (gen === null) return;
  state.dialogCopyText = '';
  dialogShow(gen, () => dialogPage(title,
    '<p>' + tr('Проверяю…', 'Checking…') + '</p>' +
    '<div class="actions">' + dialogCloseButton() + '</div>'));
  const [latestL, latestD] = await Promise.all([
    timedCheck(fetchLauncherLatest({ force: true }), UPDATE_CHECK_TIMEOUT),
    timedCheck(fetchDshLatest(), UPDATE_CHECK_TIMEOUT),
  ]);
  const [lver, dver] = await Promise.all([launcherVersionRaw(), dshVersionRaw()]);
  const isSrc = !process.execPath.startsWith('/opt/dsh-launcher/');
  const lSt = updateStatus(latestL && latestL.version, lver, isSrc ? 'semver' : 'deb');
  const dSt = updateStatus(latestD && latestD.version, dver, 'semver');
  // найденное — и в меню «Справка» (уведомлять не нужно: окно и так открыто)
  const canL = lSt === 'available' && !isSrc && Boolean(lver);
  const canD = dSt === 'available' && Boolean(dver);
  if (!NO_UPDATE_CHECK || canL || canD) {
    setAvailableUpdates({
      ...(canL ? { launcher: { version: latestL.version, installed: lver, releases: latestL.releases } } : {}),
      ...(canD ? { dsh: { version: latestD.version, installed: dver } } : {}),
    }, false);
  }
  // Диалог закрыли или открыли в нём другое — dialogShow ничего не покажет.
  dialogShow(gen, () => {
    let lStatus;
    if (lSt === 'nocheck') lStatus = tr('не удалось проверить (нет ответа GitHub)', 'could not check (no reply from GitHub)');
    else if (lSt === 'uptodate') lStatus = tr('актуальная версия', 'up to date');
    // 'notinstalled' (версию не узнали) — как и раньше, просто называем последнюю
    else lStatus = tr('доступна версия <code>' + esc(latestL.version) + '</code>', 'version <code>' + esc(latestL.version) + '</code> is available');
    let dStatus;
    if (dSt === 'nocheck') dStatus = tr('не удалось проверить (нет ответа npm)', 'could not check (no reply from npm)');
    else if (dSt === 'notinstalled') dStatus = tr('dsh не установлен', 'dsh is not installed');
    else if (dSt === 'uptodate') dStatus = tr('актуальная версия', 'up to date');
    else dStatus = tr('доступна версия <code>' + esc(latestD.version) + '</code>', 'version <code>' + esc(latestD.version) + '</code> is available');
    const row = (name, ver, status) =>
      '<tr><td style="padding:3px 14px 3px 0; color:#9aa4b2; white-space:nowrap">' + esc(name) + '</td>' +
      '<td style="padding:3px 0">' +
      (ver ? tr('установлена ', 'installed ') + '<code>' + esc(ver) + '</code>' + ' — ' + status : status) +
      '</td></tr>';
    const body = `
      <table style="border-collapse:collapse; margin-bottom:14px">
        ${row('DeepSeek Harness Launcher', lver, lStatus)}
        ${row(tr('бэкенд dsh', 'dsh backend'), dver, dStatus)}
      </table>
      ${lSt === 'available' ? notesBlockHtml(notesBetween(latestL.releases, lver, latestL.version, isSrc ? 'semver' : 'deb')) : ''}
      ${canL || canD ? '<p class="hint">' + tr('«Обновить» перезапустит лаунчер, dsh будет остановлен — незаконченный ответ агента прервётся.',
        '“Update” restarts the launcher and stops dsh — an unfinished agent reply will be interrupted.') + '</p>' : ''}
      <div class="actions">
        ${canL ? `<button onclick="location.href='dshlauncher://update-now/?k=launcher'">${tr('Обновить DeepSeek Harness Launcher', 'Update DeepSeek Harness Launcher')}</button>` : ''}
        ${canD ? `<button onclick="location.href='dshlauncher://update-now/?k=dsh'">${tr('Обновить dsh', 'Update dsh')}</button>` : ''}
        ${dialogCloseButton()}
      </div>`;
    dialogPage(title, body);
  });
}



/* ---------------- обновления во время работы ---------------- */

// Пока лаунчер работает — раз в 12 часов та же проверка, что при запуске.
// Ставить обновление посреди работы нельзя без спроса (перезапуск оборвёт
// ответ агента): только плашка в окне и пункт «Обновить … до X…» в «Справке»;
// его окно — «Что нового» и «Обновить сейчас» (перезапуск с UPDATE_NOW).
const UPDATE_POLL_MS = updatePollMs(process.env);
let availableUpdates = {};      // kind → { version, installed, releases? }
const notifiedUpdates = {};     // kind → версия, о которой уже уведомили

const updateName = (kind) => (kind === 'launcher' ? 'DeepSeek Harness Launcher' : 'dsh');

// checks — ответы проверки при запуске (updateChecks), иначе — запросить заново.
async function findUpdates(checks) {
  const [l, d] = await Promise.all(checks ? [checks.launcher, checks.dsh] : [
    timedCheck(fetchLauncherLatest(), UPDATE_CHECK_TIMEOUT),
    timedCheck(fetchDshLatest(), UPDATE_CHECK_TIMEOUT),
  ]);
  const found = {};
  const lInst = await launcherInstalledVersion();
  if (l && l.version && lInst && compareDebianVer(tagToPackageVersion(l.version), lInst) > 0) {
    found.launcher = { version: l.version, installed: lInst, releases: l.releases };
  }
  if (!state.dshInstalledVersion) {
    const r = await probeDsh(state.dshBin);
    if (r.ok) state.dshInstalledVersion = r.version;
  }
  if (d && d.version && state.dshInstalledVersion && compareSemVer(d.version, state.dshInstalledVersion) > 0) {
    found.dsh = { version: d.version, installed: state.dshInstalledVersion };
  }
  return found;
}

// Найденное → пункты меню; notify — ещё и плашка в окне.
function setAvailableUpdates(found, notify) {
  const versions = { launcher: found.launcher && found.launcher.version, dsh: found.dsh && found.dsh.version };
  const a = announceUpdates(versions, updatePrefs(), notifiedUpdates);
  const before = JSON.stringify(Object.entries(availableUpdates).map(([k, v]) => [k, v.version]));
  availableUpdates = found;
  if (JSON.stringify(Object.entries(found).map(([k, v]) => [k, v.version])) !== before) {
    for (const [kind, v] of Object.entries(a.menu)) {
      console.log(`[launcher] доступно обновление ${updateName(kind)} ${v} — пункт в меню «Справка»`);
    }
    buildAppMenu();
  }
  for (const kind of a.notify) notifiedUpdates[kind] = versions[kind];
  if (notify && a.notify.length) showUpdateToast(a.notify);
}

// После вопросов при старте: отложенное («Не сейчас») — пунктом в меню, без
// уведомления (о нём только что спросили).
async function refreshAvailableUpdates() {
  if (NO_UPDATE_CHECK) return;
  try { setAvailableUpdates(await findUpdates(updateChecks), false); }
  catch (e) { console.error('[launcher] проверка обновлений:', e.message); }
}

// Таймер периодической проверки: галочка в «Настройках» действует сразу.
let pollTimer = null;

function setUpdatePolling(on) {
  if (Boolean(pollTimer) === Boolean(on)) return;
  if (on) {
    pollTimer = setInterval(() => { void pollUpdates(); }, UPDATE_POLL_MS);
    console.log(`[launcher] периодическая проверка обновлений: раз в ${Math.round(UPDATE_POLL_MS / 1000)} с`);
  } else {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[launcher] периодическая проверка обновлений выключена');
  }
}

async function pollUpdates() {
  if (state.stopping || state.launching || state.restarting || state.relaunchRequested || updateState.running) return;
  try {
    const found = await findUpdates();
    if (!state.stopping) setAvailableUpdates(found, true);
  } catch (e) {
    console.error('[launcher] периодическая проверка обновлений:', e.message);
  }
}

// Плашка «Доступна … X» в правом верхнем углу окна, поверх страницы dsh (как
// панель поиска — WebContentsView; под ней, если поиск открыт). Висит, пока
// не закроют: пользователь мог отойти. «Подробнее…» — окно «Обновить … до X…».
const TOAST_W = 520;
const TOAST_H = 58;
let toastView = null;
let toastResizeHooked = false;

// Плашка: заголовок, строка пояснения, кнопки (переходы dshlauncher://…) и ×.
function toastPageUrl({ title, sub, buttons }) {
  const css = `html,body{margin:0;height:100%;background:#151a23;color:#d7dce3;overflow:hidden;
    font:13px system-ui,'Segoe UI',Roboto,Ubuntu,sans-serif}
    body{display:flex;align-items:center;gap:8px;padding:0 8px 0 14px;box-sizing:border-box;
    border:1px solid #3b82f6;border-radius:10px}
    .t{flex:1;min-width:0}
    .t b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .t span{color:#9aa4b2;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
    button{background:#1f2836;border:0;border-radius:7px;color:#d7dce3;height:30px;cursor:pointer;font-size:13px;padding:0 12px;white-space:nowrap}
    button:hover{background:#2a3550}
    button.x{width:28px;padding:0;font-size:14px}`;
  const html = `<!doctype html><html lang="${UI_LANG}"><head><meta charset="utf-8"><title>launcher-toast</title><style>${css}</style></head><body>
    <div class="t"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
    ${buttons.map((b) => `<button onclick="location.href='${b.href}'">${esc(b.label)}</button>`).join('')}
    <button class="x" title="${esc(tr('Закрыть', 'Close'))}" onclick="location.href='dshlauncher://toast/close/'">&#10005;</button>
    </body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function updateToastUrl(kinds) {
  const u = kinds.map((k) => availableUpdates[k]).filter(Boolean);
  return toastPageUrl({
    title: kinds.length === 1
      ? tr(`Доступна ${updateName(kinds[0])} ${u[0].version}`, `${updateName(kinds[0])} ${u[0].version} is available`)
      : tr('Доступны обновления', 'Updates are available'),
    sub: kinds.length === 1
      ? tr(`установлена ${u[0].installed}`, `installed: ${u[0].installed}`)
      : kinds.map((k) => `${updateName(k)} ${availableUpdates[k].version}`).join(', '),
    buttons: [{ label: tr('Подробнее…', 'Details…'), href: `dshlauncher://toast/open/?k=${kinds[0]}` }],
  });
}

function placeToast() {
  if (!toastView || !state.win || state.win.isDestroyed()) return;
  const [cw] = state.win.getContentSize();
  const y = 10 + (findView && findView.getVisible() ? FIND_H + 8 : 0);
  toastView.setBounds({ x: Math.max(0, cw - TOAST_W - 18), y, width: Math.min(TOAST_W, cw), height: TOAST_H });
}

function showUpdateToast(kinds) {
  console.log(`[launcher] уведомление: доступна ${kinds.map((k) => `${updateName(k)} ${availableUpdates[k].version}`).join(', ')}`);
  showToast(updateToastUrl(kinds));
}

function showToast(url) {
  if (!state.win || state.win.isDestroyed() || state.stopping) return;
  closeUpdateToast();
  toastView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  toastView.setBackgroundColor('#00000000');
  toastView.webContents.loadURL(url).catch(() => {});
  state.win.contentView.addChildView(toastView);
  if (!toastResizeHooked) { state.win.on('resize', placeToast); toastResizeHooked = true; }
  placeToast();
}

function closeUpdateToast() {
  if (!toastView) return;
  const v = toastView;
  toastView = null;
  if (state.win && !state.win.isDestroyed()) state.win.contentView.removeChildView(v);
  try { v.webContents.close(); } catch { /* уже закрыта */ }
}

function onToastRequest(route, url) {
  if (route.startsWith('/toast/open/')) {
    closeUpdateToast();
    showUpdateNowDialog(new URL(url).searchParams.get('k'));
  } else if (route.startsWith('/toast/close/')) {
    console.log('[launcher] уведомление закрыто');
    closeUpdateToast();
  } else if (route.startsWith('/toast/crash-log/')) {
    closeUpdateToast();
    void shell.openPath(fs.existsSync(LAUNCHER_LOG_FILE) ? LAUNCHER_LOG_FILE : LOG_DIR);
  } else if (route.startsWith('/toast/report/')) {
    closeUpdateToast();
    void saveReport();
  }
  return noContentResponse();
}

// Окно «Обновить … до X…»: что нового и предупреждение о перезапуске.
function showUpdateNowDialog(kind) {
  const u = availableUpdates[kind];
  if (!u) return;
  const name = updateName(kind);
  const title = tr(`Обновление ${name}`, `${name} update`);
  const gen = openDialog(title);
  if (gen === null) return;
  state.dialogCopyText = '';
  dialogShow(gen, () => dialogPage(title, `
    <p>${tr(`Доступна версия <code>${esc(u.version)}</code> (установлена <code>${esc(u.installed)}</code>).`,
            `Version <code>${esc(u.version)}</code> is available (installed: <code>${esc(u.installed)}</code>).`)}</p>
    ${kind === 'launcher' ? notesBlockHtml(notesBetween(u.releases, u.installed, u.version, 'deb')) : ''}
    <p class="hint">${tr('Лаунчер перезапустится, dsh будет остановлен — незаконченный ответ агента прервётся.',
                         'The launcher will restart and dsh will be stopped — an unfinished agent reply will be interrupted.')}</p>
    <div class="actions">
      <button onclick="location.href='dshlauncher://update-now/?k=${kind}'">${tr('Обновить сейчас', 'Update now')}</button>
      <button onclick="location.href='dshlauncher://dialog/close/'">${tr('Позже', 'Later')}</button>
    </div>`));
}

function updateNow(kind) {
  if (!availableUpdates[kind]) return;
  process.env.DSH_LAUNCHER_UPDATE_NOW = kind; // новый экземпляр — сразу к установке
  relaunchLauncher(`чтобы обновить ${updateName(kind)} до ${availableUpdates[kind].version}`);
}



/* ---------------- прошлый запуск: завершился ли штатно ---------------- */

// При запуске — метка running.json (pid, время, версия), при штатном выходе
// (will-quit) — удаляется. Осталась, а процесса нет — прошлый запуск
// завершился аварийно (падение, kill -9, выключение питания): плашка с
// «Журнал…» и «Сохранить отчёт…».
const runMarkerFile = () => path.join(app.getPath('userData'), 'running.json');
let previousCrash = null;

// Прежний экземпляр ещё работает: процесс есть, не «зомби» (завершился, но
// родитель не забрал код выхода) и это лаунчер — pid мог достаться другой
// программе.
function launcherPidAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const st = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    if (st === 'Z' || st === 'X') return false;
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(process.execPath);
  } catch { return false; } // процесса нет
}

function checkPreviousRun() {
  try {
    const m = JSON.parse(fs.readFileSync(runMarkerFile(), 'utf8'));
    if (Number.isInteger(m.pid) && m.pid !== process.pid && !launcherPidAlive(m.pid)) {
      previousCrash = m;
      console.log(`[launcher] прошлый запуск (pid ${m.pid}, ${m.version || '?'}, начат ${m.startedAt || '?'}) завершился аварийно`);
    }
  } catch { /* метки нет — прошлый завершился штатно (или первый запуск) */ }
  try {
    fs.mkdirSync(path.dirname(runMarkerFile()), { recursive: true });
    let version = null;
    try { version = require('./package.json').version; } catch { /* noop */ }
    fs.writeFileSync(runMarkerFile(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version }));
  } catch (e) { console.error('[launcher] running.json:', e.message); }
}

function clearRunMarker() {
  try { fs.unlinkSync(runMarkerFile()); } catch { /* noop */ }
}

function maybeShowCrashNotice() {
  if (!previousCrash) return;
  const m = previousCrash;
  previousCrash = null; // один раз
  console.log('[launcher] уведомление: прошлый запуск завершился аварийно');
  let when = '';
  try { when = new Date(m.startedAt).toLocaleString(UI_LANG === 'ru' ? 'ru-RU' : 'en-US'); } catch { /* noop */ }
  showToast(toastPageUrl({
    title: tr('В прошлый раз лаунчер завершился аварийно', 'The launcher closed unexpectedly last time'),
    sub: when ? tr(`запуск от ${when}`, `started ${when}`) : '',
    buttons: [
      { label: tr('Журнал…', 'Log…'), href: 'dshlauncher://toast/crash-log/' },
      { label: tr('Сохранить отчёт…', 'Save report…'), href: 'dshlauncher://toast/report/' },
    ],
  }));
}

/* ---------------- отчёт для поддержки ---------------- */

// «Справка → Сохранить отчёт…»: архив .tar.gz — сведения о системе и
// версиях, журнал лаунчера, хвост журнала dsh, настройки; токены и ключи
// скрыты (redactLog). DSH_LAUNCHER_REPORT_PATH — куда сохранить без диалога
// (тесты).
let lastReportPath = null;

async function reportFacts() {
  const [lver, dver] = await Promise.all([launcherVersionRaw(), dshVersionRaw()]);
  let osName = '';
  try { osName = (/^PRETTY_NAME="?([^"\n]*)/m.exec(fs.readFileSync('/etc/os-release', 'utf8')) || [])[1] || ''; } catch { /* noop */ }
  return [
    ['DeepSeek Harness Launcher', lver],
    [tr('бэкенд dsh', 'dsh backend'), dver],
    ['Electron', process.versions.electron],
    ['Chromium', process.versions.chrome],
    ['Node.js', process.versions.node],
    [tr('ОС', 'OS'), osName],
    [tr('ядро', 'kernel'), `${os.release()} (${os.arch()})`],
    [tr('рабочий стол', 'desktop'), process.env.XDG_CURRENT_DESKTOP],
    [tr('сессия', 'session'), process.env.XDG_SESSION_TYPE],
    [tr('режим окна', 'window mode'), app.commandLine.getSwitchValue('ozone-platform') || 'x11'],
    [tr('GPU-ускорение', 'GPU acceleration'), gpuStatusText(gpuStatusNow())],
    [tr('язык окна', 'window language'), UI_LANG],
    [tr('путь к dsh', 'path to dsh'), state.dshBin],
    [tr('аргументы dsh', 'dsh arguments'), DSH_ARGS.join(' ')],
    [tr('рабочая папка', 'working folder'), CWD],
    [tr('порт', 'port'), PORT],
    [tr('откуда настройки', 'settings source'), Object.entries(CONFIG.src).map(([k, v]) => `${k}=${v}`).join(', ')],
    [tr('лаунчер работает', 'launcher uptime'), `${Math.round(process.uptime())} s`],
    [tr('отчёт создан', 'report created'), new Date().toISOString()],
  ];
}

async function saveReport() {
  let dest = process.env.DSH_LAUNCHER_REPORT_PATH || null;
  if (!dest) {
    const parent = state.dialogWin && !state.dialogWin.isDestroyed() ? state.dialogWin : state.win;
    let dir = os.homedir();
    try { dir = app.getPath('downloads'); } catch { /* noop */ }
    const r = await dialog.showSaveDialog(parent, {
      title: tr('Сохранить отчёт', 'Save report'),
      defaultPath: path.join(dir, reportFileName(new Date())),
      filters: [{ name: 'tar.gz', extensions: ['gz'] }],
    });
    if (r.canceled || !r.filePath) return;
    dest = r.filePath;
  }
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-report-'));
    const dir = path.join(tmp, 'dsh-launcher-report');
    fs.mkdirSync(dir);
    const put = (name, text) => fs.writeFileSync(path.join(dir, name), redactLog(text));
    put('info.txt', reportInfoText(await reportFacts()));
    for (const f of [LAUNCHER_LOG_FILE + '.1', LAUNCHER_LOG_FILE]) {
      try { put(path.basename(f), fs.readFileSync(f, 'utf8')); } catch { /* нет файла */ }
    }
    const dshTail = logTail(LOG_FILE, 5000, 1024 * 1024);
    if (dshTail !== null) put('dsh.log.tail', dshTail + '\n');
    put('settings.json', JSON.stringify(loadSettings() || {}, null, 2) + '\n');
    try { put('gpu.json', JSON.stringify(app.getGPUFeatureStatus(), null, 2) + '\n'); } catch { /* noop */ }
    await execFileAsync('tar', ['-czf', dest, '-C', tmp, 'dsh-launcher-report']);
    lastReportPath = dest;
    console.log(`[launcher] отчёт сохранён: ${dest}`);
    showReportDialog(null);
  } catch (e) {
    console.error('[launcher] отчёт:', e.message);
    showReportDialog(e.message);
  } finally {
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function showReportDialog(error) {
  const title = tr('Отчёт', 'Report');
  const gen = openDialog(title);
  if (gen === null) return;
  state.dialogCopyText = '';
  dialogShow(gen, () => dialogPage(title, error
    ? `<p class="note err">${esc(tr('Не удалось сохранить отчёт: ', 'Could not save the report: ') + error)}</p>
       <div class="actions">${dialogCloseButton()}</div>`
    : `<p>${tr('Отчёт сохранён:', 'Report saved:')} <code>${esc(lastReportPath)}</code></p>
       <p class="hint">${tr('Токены и ключи в нём скрыты. Приложите файл к сообщению о проблеме на',
                            'Tokens and keys in it are hidden. Attach the file to an issue on')}
         <a href="https://github.com/${UPDATE_GITHUB_REPO}/issues/new" target="_blank">GitHub</a>.</p>
       <div class="actions">
         <button onclick="location.href='dshlauncher://dialog/report-show/'">${tr('Показать в папке', 'Show in folder')}</button>
         ${dialogCloseButton()}
       </div>`));
}

/* ---------------- трей и работа в фоне ---------------- */

// «Настройки → Окно»: closeToTray — крестик прячет окно в трей, dsh работает
// дальше (по умолчанию выключено: без поддержки трея на рабочем столе —
// в «чистом» GNOME нет — окно пропало бы без значка; вернуть его можно и
// повторным запуском лаунчера). attention — привлечь внимание, когда агент
// закончил ответ, а окно не в фокусе (по умолчанию включено).
let tray = null;
let trayIcons = null;

const closeToTrayOn = () => (loadSettings() || {}).closeToTray === true;
const attentionOn = () => (loadSettings() || {}).attention !== false;
const attentionSoundOn = () => (loadSettings() || {}).attentionSound === true;

// Значок трея и он же с оранжевой точкой («агент закончил»).
function makeTrayIcons() {
  let base = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
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
    { label: tr('Перезапустить dsh…', 'Restart dsh…'), click: () => { showMainWindow(); void restartDsh(); } },
    { type: 'separator' },
    { label: tr('Выйти', 'Quit'), click: () => app.quit() },
  ]);
}

function setTray(on) {
  if (Boolean(tray) === Boolean(on)) return;
  if (on) {
    if (!trayIcons) trayIcons = makeTrayIcons();
    tray = new Tray(trayIcons.normal);
    tray.setToolTip('DeepSeek Harness');
    tray.setContextMenu(trayMenu());
    tray.on('click', () => showMainWindow());
    console.log('[launcher] трей включён: крестик прячет окно, dsh работает дальше');
  } else {
    tray.destroy();
    tray = null;
    console.log('[launcher] трей выключен');
    if (state.win && !state.win.isDestroyed() && !state.win.isVisible()) showMainWindow(); // не оставить окно спрятанным без значка
  }
}

function setTrayAttention(on) {
  if (!tray || !trayIcons) return;
  tray.setImage(on ? trayIcons.attention : trayIcons.normal);
  tray.setToolTip(on ? tr('DeepSeek Harness — агент закончил ответ', 'DeepSeek Harness — the agent has finished') : 'DeepSeek Harness');
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
  if (!tray || !closeToTrayOn() || state.stopping || state.relaunchRequested || state.restarting) return;
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
let agentNotification = null; // ссылка — чтобы уведомление (и его click) не собрал GC

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
    icon: path.join(__dirname, 'icon.png'),
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
  if (tray) { setTrayAttention(true); console.log('[launcher] значок трея: агент закончил ответ'); }
  if (!hidden) state.win.flashFrame(true);
  if (attentionSoundOn()) playAgentSound();
}

/* ---------------- запуск dsh и доведение окна до GUI ---------------- */

// Защита от повторного запуска: двойной клик «Проверить ещё раз» или
// «Установить» вызвал бы launchDsh дважды — второй spawn перезаписал бы
// dshProc, и первый процесс остался бы без присмотра (не убит при закрытии).
state.launching = false;

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
    if (await offerLauncherUpdate()) return; // перезапуск в новую версию — dsh поднимет она
    if (state.stopping) return;
    await offerDshUpdate();
    if (state.stopping) return;
    await offerMarketIfMissing();
    if (state.stopping) return;
    void refreshAvailableUpdates(); // отложенное обновление — пунктом в «Справке»
    await launchDshInner();
  } finally {
    state.launching = false;
  }
}

async function launchDshInner() {
  showPage(() => showStatus(tr('Запуск DeepSeek Harness…', 'Starting DeepSeek Harness…'), tr(
    `<p>Запускаю <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>Жду, пока сервис поднимется…</p>`,
    `<p>Running <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>Waiting for the service to come up…</p>`)));
  startDsh();

  const up = await waitForPort();
  if (!up) {
    showPage(() => showStatus(tr('Не удалось запустить dsh', 'Failed to start dsh'), tr(
      `<p>Процесс не поднял сервис на <code>${PLAIN_URL}</code>.<br>
         Проверьте, что команда запускается в терминале:
         <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>
         Последние строки журнала:</p>`,
      `<p>The process did not bring up the service at <code>${PLAIN_URL}</code>.<br>
         Check that the command runs in a terminal:
         <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>.<br>
         Latest log lines:</p>`) + stderrBlock(), true));
    startWatchdog(); // если dsh запустят вручную — окно оживёт само
    return;
  }

  // Порт уже поднят нами: проверка watchdog, начатая во время запуска и
  // завершившаяся после, не должна принять это за перезапуск dsh.
  state.portState = 'up';
  const url = state.authUrl || (await waitForAuthUrl());
  if (url) {
    await loadInWin(url); // обмен токена на куки, затем редирект на чистый URL
  } else if (await plainUrlIsAuthed()) {
    await loadInWin(PLAIN_URL); // старое куки ещё валидно
  } else {
    showPastePage();
  }
  startWatchdog();
}

/* ---------------- основной поток ---------------- */

protocol.registerSchemesAsPrivileged([
  { scheme: 'dshlauncher', privileges: { standard: false, secure: true } },
]);

async function plainUrlIsAuthed() {
  try {
    const res = await electronNet.fetch(PLAIN_URL, { redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

/* ---------------- авто-восстановление после перезапуска dsh ----------------
 * GUI сам не возобновляет текущую сессию, когда процесс dsh перезапускается:
 * окно застревает на «сессия завершена». Но всё нужное для возобновления
 * сохраняется на диске: сессионный куки (секрет подписи живёт в
 * ~/.dsh/.credentials.yaml), сами сессии (~/.dsh/sessions) и состояние
 * интерфейса (localStorage). Поэтому при переходе порта down→up достаточно
 * перезагрузить страницу — приложение восстановится само.
 */
let watchdogStarted = false;
state.portState = null; // null | 'up' | 'down'
let lastAutoReloadAt = 0;

async function recoverWindow(force = false) {
  if (!state.win || state.win.isDestroyed() || state.stopping) return;
  const now = Date.now();
  if (!force && now - lastAutoReloadAt < 3000) return; // защита от флаттера порта
  lastAutoReloadAt = now;
  try {
    let cur = 'about:blank';
    try { cur = state.win.webContents.getURL(); } catch { return; }
    const dshOrigin = new URL(PLAIN_URL).origin;
    let onDshPage = false;
    try { onDshPage = new URL(cur).origin === dshOrigin; } catch { /* data: и т.п. */ }
    if (onDshPage) {
      await loadInWin(PLAIN_URL);
    } else if (await plainUrlIsAuthed()) {
      await loadInWin(PLAIN_URL); // окно на статус-странице, но куки валидны
    } else {
      showPastePage(); // куки не пережили перезапуск — нужен токен нового процесса
    }
  } catch (e) {
    console.error('[launcher] recover:', e.message);
  }
}

function startWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  (async () => {
    state.portState = (await portOpen()) ? 'up' : 'down'; // базовое состояние, без срабатываний
    setInterval(async () => {
      if (state.stopping) return;
      const now = (await portOpen()) ? 'up' : 'down';
      if (now === state.portState) return;
      if (now === 'up' && state.launching) {
        state.portState = now; // окно доведёт до GUI сам launchDsh — не мешаем ему второй навигацией
        return;
      }
      if (now === 'up') {
        console.log(`[launcher] dsh снова отвечает на порту ${PORT} — обновляю окно`);
        state.portState = now;
        recoverWindow();
      } else {
        console.log(`[launcher] порт ${PORT} закрыт — если dsh перезапустят, окно восстановится само`);
        state.portState = now;
      }
    }, 1500);
  })();
}

// Маршрут запроса dshlauncher://…: у нестандартной схемы первый сегмент
// (retry, install, paste, market) URL-парсер кладёт в host, а не в pathname —
// склеиваем обратно: dshlauncher://install/run/ -> '/install/run/'.


function onPasteRequest(request) {
  try {
    const pasted = decodeURIComponent(launcherRoute(request.url).replace(/^\/paste\//, ''));
    if (/^https?:\/\//i.test(pasted) && state.win && !state.win.isDestroyed()) {
      console.log('[launcher] loading pasted URL');
      state.win.loadURL(pasted).catch((e) => console.error('[launcher] loadURL:', e.message));
    }
  } catch (e) {
    console.error('[launcher] paste handler:', e.message);
  }
  return new Response('<!doctype html><html><body style="background:#0f1115;margin:0"></body></html>',
    { headers: { 'content-type': 'text/html' } });
}

// «Проверить снова» на фатальной странице: если dsh запустили вручную
// (например, в терминале), а окно оставили открытым — возвращаемся в GUI.
async function onRetryRequest() {
  try {
    if (state.win && !state.win.isDestroyed() && !state.stopping) {
      const up = await portOpen();
      if (up) {
        state.weStartedDsh = false; // чужой dsh — при закрытии окна его не убиваем
        state.dshProc = null;
        state.dshFatal = false;
        state.portState = 'up';
        if (await plainUrlIsAuthed()) {
          console.log('[launcher] retry: dsh запущен, куки валидны — открываю GUI');
          await loadInWin(PLAIN_URL);
        } else {
          console.log('[launcher] retry: dsh запущен, валидного куки нет — страница вставки');
          showPastePage();
        }
      } else {
        // Бинарник мог исчезнуть (разустановка, другой DSH_BIN) — тогда
        // совет запускать его в терминале бессмысленен.
        if (!(await dshInstallCheck()).ok) {
          showInstallPage(() => tr('dsh не найден — установите его (команда на странице).',
            'dsh not found — install it (the command is on this page).'));
        } else {
          showPage(() => showStatus(tr('dsh не запущен', 'dsh is not running'), tr(
            `<p>Порт ${PORT} закрыт — <code>dsh</code> не запущен.</p>
               <p>Запустите его в терминале: <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>
               и нажмите «Проверить снова». Либо закройте окно и запустите
               dsh-launcher снова.</p>`,
            `<p>Port ${PORT} is closed — <code>dsh</code> is not running.</p>
               <p>Start it in a terminal: <code>${esc(state.dshBin)} ${esc(DSH_ARGS.join(' '))}</code>
               and click “Check again”. Or close this window and start
               dsh-launcher again.</p>`) + retryButton(), false));
        }
      }
    }
  } catch (e) {
    console.error('[launcher] onRetryRequest:', e.message);
  }
  return new Response('<!doctype html><html><body style="background:#0f1115;margin:0"></body></html>',
    { headers: { 'content-type': 'text/html' } });
}

function blankResponse() {
  return new Response('<!doctype html><html><body style="background:#0f1115;margin:0"></body></html>',
    { headers: { 'content-type': 'text/html' } });
}

// «Нет содержимого»: навигация не происходит, страница остаётся как была.
function noContentResponse() {
  return new Response(null, { status: 204 });
}

// «Скопировать команду» на странице установки dsh.
async function onInstallCopy() {
  try {
    if (!installState.npmInfo) await refreshInstallState();
    clipboard.writeText(installState.npmInfo.command);
    console.log('[launcher] команда установки скопирована в буфер обмена');
    await showInstallPage(() => tr('Команда скопирована в буфер обмена — вставьте её в терминал.', 'Command copied to the clipboard — paste it into a terminal.'));
  } catch (e) {
    console.error('[launcher] onInstallCopy:', e.message);
    showInstallPage(() => tr('Не удалось скопировать команду: ' + e.message, 'Failed to copy the command: ' + e.message), true);
  }
  return blankResponse();
}

// «Проверить ещё раз»: dsh появился (поставили вручную или кнопкой) — продолжаем запуск.
async function onInstallRecheck() {
  try {
    if (installState.running) return blankResponse(); // установка идёт — страница обновится сама
    await refreshInstallState();
    if (installState.check.ok) {
      console.log(`[launcher] dsh найден (${installState.check.version}) — начинаю запуск`);
      await launchDsh();
      return blankResponse();
    }
    console.log(installState.check.reason === 'broken'
      ? `[launcher] повторная проверка: dsh найден, но не запускается (${installState.check.detail || ''})`
      : '[launcher] повторная проверка: dsh всё ещё не найден');
    showInstallPage(() => installState.check && installState.check.reason === 'broken'
      ? tr('dsh найден, но не запускается — причина ниже.', 'dsh was found but does not run — see the reason below.')
      : tr('dsh всё ещё не найден — установите его командой выше, затем проверьте снова.', 'dsh is still not found — install it with the command above, then check again.'), true);
  } catch (e) {
    console.error('[launcher] onInstallRecheck:', e.message);
    showInstallPage(() => tr('Ошибка проверки: ' + e.message, 'Check failed: ' + e.message), true);
  }
  return blankResponse();
}

// «Установить»: npm install -g прямо из окна, с живым логом.
async function onInstallRun() {
  try {
    if (installState.running || !state.win || state.win.isDestroyed() || state.stopping) return blankResponse();
    await refreshInstallState();
    if (installState.running) return blankResponse(); // пока проверяли, установку уже запустили
    const npmInfo = installState.npmInfo;
    if (!npmInfo.canAuto) {
      showInstallPage(() => tr('Кнопка «Установить» недоступна: глобальный npm prefix требует sudo — выполните команду в терминале.', '“Install” is unavailable: the global npm prefix requires sudo — run the command in a terminal.'), true);
      return blankResponse();
    }
    installState.running = true;
    installState.log = [];
    console.log(`[launcher] установка dsh из окна: ${npmInfo.command}`);
    installState.proc = spawn(npmInfo.npm, ['install', '-g', '@deepseek-ai/dsh'],
      { env: envWithBinDir(npmInfo.npm), stdio: ['ignore', 'pipe', 'pipe'] });
    const p = installState.proc;
    const onData = (d) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        installState.log.push(t);
        if (installState.log.length > 500) installState.log.shift();
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    installState.timer = setInterval(() => showInstallPage(), 800);
    const code = await new Promise((resolve) => {
      let settled = false;
      const done = (c) => { if (!settled) { settled = true; resolve(c); } };
      p.on('close', (c) => done(c === null ? -1 : c));
      p.on('error', () => done(-1)); // npm не запустился — close может не прийти
    });
    clearInterval(installState.timer);
    installState.running = false;
    installState.proc = null;
    if (code === 0) {
      console.log('[launcher] dsh установлен — продолжаю запуск');
      // Если prefix не /usr, бинарник лёг не в /usr/bin — находим и запоминаем фактический путь.
      const check = await dshInstallCheck();
      if (!check.ok) {
        showInstallPage(() => tr('npm сообщил об успехе, но dsh так и не запускается — см. детали ниже.',
          'npm reported success, but dsh still does not run — see details below.'), true);
        return blankResponse();
      }
      await launchDsh();
    } else {
      console.error(`[launcher] установка dsh завершилась с кодом ${code}`);
      showInstallPage(() => tr(`Установка завершилась с кодом ${code} (строки выше) — повторите в терминале.`, `Installation exited with code ${code} (see output above) — retry in a terminal.`), true);
    }
  } catch (e) {
    console.error('[launcher] onInstallRun:', e.message);
    installState.running = false;
    try { clearInterval(installState.timer); } catch { /* noop */ }
    showInstallPage(() => tr('Не удалось запустить установку: ' + e.message, 'Failed to start the installation: ' + e.message), true);
  }
  return blankResponse();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow()); // в т.ч. спрятанное в трей
  app.whenReady().then(onReady);
}

async function onReady() {
  checkPreviousRun(); // блокировка «один экземпляр» уже наша
  installSignalHandlers();
  buildAppMenu(); // «Файл», «Правка», «Вид», «Справка» (подписи следуют за
                  // языком окна, при RU|EN собирается заново)
  loadLangPref();
  // Проверки обновлений — параллельно всему остальному; перед стартом dsh
  // их ждём не дольше UPDATE_CHECK_TIMEOUT.
  startUpdateChecks();
  if (CONFIG.pollUpdates) setUpdatePolling(true);
  if (closeToTrayOn()) setTray(true);
  setInterval(() => { void pollAgentState(); }, AGENT_POLL_MS);
  protocol.handle('dshlauncher', (request) => {
    try {
      const route = launcherRoute(request.url);
      if (route.startsWith('/retry/')) return onRetryRequest();
      if (route.startsWith('/lang/')) return onLangSwitch(route.split('/')[2]);
      if (route.startsWith('/install/copy/')) return onInstallCopy();
      if (route.startsWith('/install/run/')) return onInstallRun();
      if (route.startsWith('/install/recheck/')) return onInstallRecheck();
      if (route.startsWith('/market/install/')) return onMarketChoice('install');
      if (route.startsWith('/market/skip/')) return onMarketChoice('skip');
      if (route.startsWith('/market/never/')) return onMarketChoice('never');
      if (route.startsWith('/update/install/')) return onUpdateChoice('install');
      if (route.startsWith('/update/later/')) return onUpdateChoice('later');
      if (route.startsWith('/update/never/')) return onUpdateChoice('never');
      if (route.startsWith('/update/recheck/')) return onUpdateChoice('recheck');
      if (route.startsWith('/update/copy/')) return onUpdateChoice('copy');
      if (route.startsWith('/update/restart/')) return onUpdateChoice('restart');
      // О программе / проверка обновлений по URL — для Docker-сценариев
      // (driver.js не умеет кликать по нативному меню); штатно — пункт меню.
      // Ответ 204: страница, с которой перешли (GUI dsh), остаётся на месте.
      if (route.startsWith('/menu/about/')) { void showAboutDialog(); return noContentResponse(); }
      if (route.startsWith('/menu/check/')) { void showUpdateCheckDialog(); return noContentResponse(); }
      if (route.startsWith('/menu/update/')) { showUpdateNowDialog(new URL(request.url).searchParams.get('k')); return noContentResponse(); }
      if (route.startsWith('/toast/')) return onToastRequest(route, request.url);
      if (route.startsWith('/update-now/')) { updateNow(new URL(request.url).searchParams.get('k')); return noContentResponse(); }
      if (route.startsWith('/find/')) return onFindRequest(route, request.url);
      if (route.startsWith('/dialog/logs/')) { void openLogsFolder(); return noContentResponse(); }
      if (route.startsWith('/window/close/')) { if (state.win && !state.win.isDestroyed()) state.win.close(); return noContentResponse(); }
      if (route.startsWith('/menu/report/')) { void saveReport(); return noContentResponse(); }
      if (route.startsWith('/dialog/report-show/')) { if (lastReportPath) shell.showItemInFolder(lastReportPath); return noContentResponse(); }
      if (route.startsWith('/dialog/log-refresh/')) { if (state.dialogRender) state.dialogRender(false); return noContentResponse(); }
      if (route.startsWith('/menu/log/')) { showLogDialog(); return noContentResponse(); }
      if (route.startsWith('/menu/settings/')) { showSettingsDialog(); return noContentResponse(); }
      if (route.startsWith('/settings/set/')) return onSettingsSet(request.url);
      if (route.startsWith('/settings/section/')) {
        const sec = new URL(request.url).searchParams.get('s');
        if (SETTINGS_SECTIONS.includes(sec)) settingsSection = sec;
        return noContentResponse();
      }
      if (route.startsWith('/settings/pick-dsh/')) return onSettingsPick('dshPath');
      if (route.startsWith('/settings/pick-cwd/')) return onSettingsPick('cwd');
      if (route.startsWith('/settings/reset-updates/')) return onSettingsResetUpdates();
      if (route.startsWith('/settings/relaunch/')) { relaunchLauncher(); return noContentResponse(); }
      if (route.startsWith('/menu/close-context/')) { if (openContextMenu) openContextMenu.closePopup(); return noContentResponse(); }
      if (route.startsWith('/dialog/gpu-enable/')) return onDialogGpuEnable();
      if (route.startsWith('/menu/restart-dsh/')) { void restartDsh({ confirm: false }); return noContentResponse(); }
      if (route.startsWith('/dialog/close/')) return onDialogClose();
      if (route.startsWith('/dialog/copy/')) return onDialogCopy();
    } catch { /* noop */ }
    return onPasteRequest(request);
  });

  const size = windowSize(loadWindowState(), screen.getPrimaryDisplay().workAreaSize);
  state.win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: WIN_MIN.width,
    minHeight: WIN_MIN.height,
    title: 'DeepSeek Harness',
    backgroundColor: '#0f1115',
    autoHideMenuBar: false, // строка меню всегда видна
    show: false,
    // spellcheck включён всегда, а вкл/выкл — session.setSpellCheckerEnabled
    // (меню «Вид»): так переключается без перезапуска.
    // autoplayPolicy — звук «агент закончил» (WebAudio) без нажатия в окне
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  if (size.maximized) state.win.maximize();
  trackWindowState(state.win);
  state.win.on('close', onMainWindowClose);
  state.win.on('focus', () => { state.win.flashFrame(false); setTrayAttention(false); });
  initSpellcheck();
  state.win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Правый клик — контекстное меню (копировать / вставить …): своего у
  // Electron нет. И в GUI dsh, и на служебных страницах лаунчера.
  state.win.webContents.on('context-menu', (_e, params) => showContextMenu(params));
  // диагностика: из лога должно быть видно, что окно показало и что загрузилось
  state.win.once('ready-to-show', () => { state.win.show(); console.log('[launcher] окно показано'); });
  // Страховка: на нативном Wayland ready-to-show может прийти с большим
  // опозданием (или не прийти вовсе) — окно с show:false остаётся невидимым.
  // Если через 8 с оно всё ещё не показано — показываем вручную.
  setTimeout(() => {
    // isDestroyed: окно могли закрыть (и app.quit()) раньше таймера —
    // методы на уничтоженном окне бросают исключение.
    if (state.win && !state.win.isDestroyed() && !state.win.isVisible()) {
      console.log('[launcher] ready-to-show не пришло за 8 с — показываю окно вручную');
      state.win.show();
    }
  }, 8000);
  state.win.webContents.on('did-finish-load', () => {
    // первая загрузка GUI dsh — показать «Что нового», если лаунчер обновился
    try {
      if (new URL(state.win.webContents.getURL()).origin === new URL(PLAIN_URL).origin) { void maybeShowWhatsNew(); maybeShowCrashNotice(); }
    } catch { /* data: */ }
    // перезагрузка под открытым диалогом (watchdog) сбрасывает затемнение
    if (state.dialogWin && !state.dialogWin.isDestroyed()) { dimKey = null; void dimMain(true); }
    try { console.log('[launcher] страница загружена:', state.win.webContents.getURL().slice(0, 120)); } catch { /* noop */ }
  });
  state.win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) console.error(`[launcher] ошибка загрузки: code=${code} ${desc} url=${String(url).slice(0, 120)}`);
  });
  state.win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[launcher] рендер-процесс завершился:', details.reason, 'exitCode=' + details.exitCode);
    if (launcherUpdatedOnDisk) restartLauncher(); // новые файлы на диске — старому не подняться
  });

  // Клавиши «как в браузере» (F5, Ctrl+R, Ctrl+= / - / 0, Ctrl+F, F3, F11) —
  // keyAction → viewActions; в меню «Вид» те же действия. Ускорители меню
  // не регистрируются — только подсказки, чтобы не перебивать клавиши GUI dsh.
  try {
    const savedZoom = JSON.parse(fs.readFileSync(zoomFile(), 'utf8'));
    if (Number.isFinite(savedZoom.zoomLevel)) {
      state.win.webContents.setZoomLevel(Math.max(-5, Math.min(5, savedZoom.zoomLevel)));
      console.log(`[launcher] восстановлен масштаб: ${savedZoom.zoomLevel}`);
    }
  } catch { /* noop */ }
  state.win.webContents.on('before-input-event', (event, input) => {
    try {
      if (input.type !== 'keyDown') return;
      const act = keyAction(input);
      if (!act) return;
      event.preventDefault();
      viewActions[act]();
    } catch (e) { console.error('[launcher] ошибка в обработчике клавиш:', e); }
  });

  const alreadyRunning = await portOpen();
  if (alreadyRunning) {
    console.log('[launcher] port already open — attaching to running dsh');
    showPage(() => showStatus(tr('Подключение…', 'Connecting…'), tr(
      `<p><code>dsh</code> уже запущен на порту ${PORT}. Подключаюсь…</p>`,
      `<p><code>dsh</code> is already running on port ${PORT}. Connecting…</p>`)));
    if (await plainUrlIsAuthed()) {
      console.log('[launcher] валидный куки есть — открываю GUI');
      await loadInWin(PLAIN_URL);
    } else {
      console.log('[launcher] валидного куки нет — показываю страницу вставки токена');
      showPastePage();
    }
    startWatchdog();
    return;
  }

  // Порт закрыт — будем запускать dsh сами. Сначала проверяем, что он вообще
  // установлен: иначе вместо понятной страницы — ENOENT после попытки старта.
  const installCheck = await dshInstallCheck();
  state.dshInstalledVersion = installCheck.version || null;
  if (!installCheck.ok) {
    console.log(
      `[launcher] dsh не найден (${installCheck.reason}` +
      (installCheck.detail ? ': ' + installCheck.detail : '') +
      ') — показываю страницу установки'
    );
    showInstallPage();
    startWatchdog(); // если dsh поставят и запустят вручную — окно оживёт само
    return;
  }
  await launchDsh();
}

/* ---------------- закрытие = остановка ---------------- */

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
  if (state.stopping) return;
  state.stopping = true;
  e.preventDefault();
  if (installState.running && installState.proc) {
    try { installState.proc.kill('SIGTERM'); } catch { /* noop */ }
  }
  if (marketState.proc) {
    try { marketState.proc.kill('SIGTERM'); } catch { /* noop */ }
  }
  if (updateState.proc) {
    try { updateState.proc.kill('SIGTERM'); } catch { /* noop */ }
  }
  try { clearInterval(updateState.timer); } catch { /* noop */ }
  if (updateState.restartTimer) {
    clearTimeout(updateState.restartTimer);
    updateState.restartTimer = null;
  }
  Promise.resolve().then(async () => {
    await stopDsh();
    if (state.adoptedDsh) await stopAdoptedDsh();
  }).finally(() => {
    if (state.relaunchRequested) { try { spawnNewInstance(); } catch (e) { console.error('[launcher] перезапуск:', e.message); } }
    app.quit();
  });
});

// страховка: если before-quit почему-то не сработала — жёстко
app.on('will-quit', () => { killDshNow(); clearRunMarker(); });

// страховка на «жёсткое» завершение самого лаунчера: SIGTERM/SIGINT/SIGHUP (pkill,
// завершение сессии) и exit процесса. Поймать SIGKILL, отправленный самому
// лаунчеру, нельзя — в том случае dsh переживёт его (это ограничение
// отделимого процесса, лечится только системно — cgroup/supervisor).
function killDshNow() {
  if (state.weStartedDsh && state.dshProc && state.dshProc.pid !== undefined && !state.dshFatal) {
    killGroup(state.dshProc.pid, 'SIGKILL', dshLeaderExited());
  }
  if (state.adoptedDsh) {
    for (const t of adoptedTargets()) killGroup(t.id, 'SIGKILL', t.groupOnly);
  }
}
// По сигналу — штатное закрытие через before-quit (dsh получает SIGTERM и
// успевает сохраниться, через 4 с — SIGKILL). Жёстко (SIGKILL дереву и
// выход) — по повторному сигналу, если приложение ещё не готово или если
// штатное закрытие не уложилось в 8 с.
let termSignalSeen = false;
function onTermSignal(name, exitCode) {
  console.log(`[launcher] ${name} — останавливаю dsh`);
  if (termSignalSeen || !app.isReady()) {
    killDshNow();
    process.exit(exitCode);
  }
  termSignalSeen = true;
  setTimeout(() => {
    console.error('[launcher] штатное закрытие зависло — останавливаю dsh жёстко');
    killDshNow();
    process.exit(exitCode);
  }, 8000);
  app.quit();
}
// Ставить — после ready: Chromium при старте ставит свой обработчик
// SIGTERM/SIGINT/SIGHUP поверх раннего process.on (тот так и не вызывается),
// а после первого сигнала возвращает обработчик по умолчанию — повторный
// сигнал убивал лаунчер мгновенно, и медленно завершающийся dsh оставался
// сиротой. Поставленный позже, наш обработчик заменяет chromium-овский.
function installSignalHandlers() {
  process.on('SIGINT', () => onTermSignal('SIGINT', 130));
  process.on('SIGTERM', () => onTermSignal('SIGTERM', 143));
  process.on('SIGHUP', () => onTermSignal('SIGHUP', 129));
}
process.on('exit', killDshNow);
