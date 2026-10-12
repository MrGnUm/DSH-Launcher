'use strict';
// «Что нового» после обновления лаунчера.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const state = require('./state');
const i18n = require('./i18n');
const { tr } = i18n;
const { esc, timedCheck } = require('./util');
const { tagToPackageVersion, shouldShowWhatsNew, notesBetween } = require('./versions');
const dialogs = require('./dialogs');
const menus = require('./menus');
const updates = require('./updates');

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
  const current = await menus.launcherVersionRaw();
  if (!current) return;
  let last = null;
  try { last = JSON.parse(fs.readFileSync(lastVersionFile(), 'utf8')).version || null; } catch { /* первый запуск */ }
  const scheme = process.execPath.startsWith('/opt/dsh-launcher/') ? 'deb' : 'semver';
  if (!shouldShowWhatsNew(last, current, scheme)) { saveLastVersion(current); return; }
  if (updates.NO_UPDATE_CHECK) { saveLastVersion(current); return; } // в сеть ходить нельзя — молча
  let latest = await state.updateChecks.launcher;
  // Список релизов из кэша (до часа) мог быть получен до выхода этой версии
  // (например, пакет поставили через apt) — тогда её описания в нём нет:
  // запросить заново, мимо кэша.
  const hasCurrent = (l) => l && Array.isArray(l.releases) && l.releases.some((r) =>
    (scheme === 'deb' ? tagToPackageVersion(r.version) : r.version) === current);
  if (latest && !hasCurrent(latest)) {
    console.log(`[launcher] в кэше релизов нет ${current} — запрашиваю список заново`);
    latest = (await timedCheck(updates.fetchLauncherLatest({ force: true }), updates.UPDATE_CHECK_TIMEOUT)) || latest;
  }
  if (!latest || !latest.releases) return; // нет ответа GitHub — покажем в следующий раз
  const items = notesBetween(latest.releases, last, current, scheme);
  console.log(`[launcher] обновлён ${last} → ${current} — показываю «Что нового» (${items.length})`);
  saveLastVersion(current);
  const title = tr('Что нового', 'What’s new');
  const gen = dialogs.openDialog(title);
  if (gen === null) return;
  state.dialogCopyText = '';
  const link = `https://github.com/${updates.UPDATE_GITHUB_REPO}/releases`;
  dialogs.dialogShow(gen, () => dialogs.dialogPage(title, `
    <p style="margin:0 0 4px">${tr('DeepSeek Harness Launcher обновлён:', 'DeepSeek Harness Launcher was updated:')} <code>${esc(last)}</code> → <code>${esc(current)}</code></p>
    ${updates.notesBlockHtml(items) || `<p>${tr('Подробности — на', 'Details are on the')} <a href="${esc(link)}" target="_blank">${tr('странице релизов', 'releases page')}</a>.</p>`}
    <div class="actions">${dialogs.dialogCloseButton()}</div>`));
}

Object.assign(module.exports, { maybeShowWhatsNew }); // дополняем, а не заменяем: модули подключают друг друга по кругу