'use strict';
// Язык окон лаунчера: tr(ru, en) — строка на текущем языке. Язык выбирает
// main.js (переменная, переключатель RU | EN, «Настройки», локаль) — setLang.
let lang = 'en';

const tr = (ru, en) => (lang === 'ru' ? ru : en);
const getLang = () => lang;
function setLang(l) { lang = l === 'ru' ? 'ru' : 'en'; }

module.exports = { tr, getLang, setLang };
