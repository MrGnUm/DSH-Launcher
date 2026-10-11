'use strict';
// Обновления — чистая логика: кэш списка релизов, интервал периодической
// проверки, что показать (пункт меню, плашка) по найденным версиям, прокси.

/* Как получить список релизов GitHub: 'revalidate' — спросить с
   If-None-Match (есть метка ETag; ответ 304 «не изменилось» не расходует
   лимит 60/ч — поэтому всегда, и новый релиз виден сразу), 'cache' —
   взять запомненный без запроса (метки нет, а проверяли меньше maxAgeMs
   назад; ручная проверка — force — так не делает), 'fetch' — обычный
   запрос. */
function releasesCacheMode(entry, now, maxAgeMs, force) {
  const ok = entry && typeof entry === 'object' && Array.isArray(entry.list);
  if (!ok) return 'fetch';
  if (entry.etag) return 'revalidate';
  if (!force && releasesCacheFresh(entry, now, maxAgeMs)) return 'cache';
  return 'fetch';
}

// Кэш проверяли меньше maxAgeMs назад (время из будущего — часы сдвинули — нет).
function releasesCacheFresh(entry, now, maxAgeMs) {
  return Boolean(entry) && Number.isFinite(entry.fetchedAt) && now - entry.fetchedAt >= 0 && now - entry.fetchedAt < maxAgeMs;
}

/* updatePollMs — интервал периодической проверки: 12 часов
   (DSH_LAUNCHER_UPDATE_POLL_SEC — для тестов). announceUpdates — что
   показать по найденным обновлениям: found — { launcher, dsh } (новые
   версии или null), dismissed — update-prefs.json («не спрашивать больше»
   по версиям), notified — о каких версиях уже уведомляли в этом сеансе.
   → { menu: { kind: версия } — пункты «Обновить … до X…» в «Справке»,
       notify: [kind] — системные уведомления (раз на версию; не для
       отклонённой — пункт меню для неё всё же есть) }. */
function updatePollMs(env) {
  const sec = Number(env.DSH_LAUNCHER_UPDATE_POLL_SEC);
  return Number.isFinite(sec) && sec >= 1 ? Math.round(sec * 1000) : 12 * 3600 * 1000;
}

function announceUpdates(found, dismissed, notified) {
  const menu = {};
  const notify = [];
  for (const kind of ['launcher', 'dsh']) {
    const v = found && found[kind];
    if (!v) continue;
    menu[kind] = v;
    if ((dismissed || {})[kind] !== v && (notified || {})[kind] !== v) notify.push(kind);
  }
  return { menu, notify };
}

/* Правило Chromium («PROXY h:p; DIRECT», «HTTPS h:p», «SOCKS5 h:p», «DIRECT»)
   → URL прокси для Node или null (напрямую). Берём первый HTTP(S)-прокси;
   SOCKS агент Node не умеет — тогда напрямую. */
function proxyUrlFromRule(rule) {
  for (const part of String(rule || '').split(';')) {
    const m = part.trim().match(/^(PROXY|HTTPS)\s+(\S+)$/i);
    if (m) return (m[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://') + m[2];
  }
  return null;
}

module.exports = { releasesCacheMode, releasesCacheFresh, updatePollMs, announceUpdates, proxyUrlFromRule };
