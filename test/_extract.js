'use strict';
// Общий помощник для юнит-тестов: извлекает функцию из main.js по парным
// маркерам «/* ===== имя … ===== */» / «/* ===== end имя ===== */».
// main.js целиком не загружается (он требует electron).
const fs = require('fs');
const path = require('path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// помеченные блоки ищем в main.js и в модулях src/ (код переезжает из main.js)
const srcDir = path.join(__dirname, '..', 'src');
const sources = [mainSrc, ...fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8'))];

function extract(name, deps = {}) {
  const text = sources.find((t) => t.includes('/* ===== ' + name + ' ') && t.includes('/* ===== end ' + name + ' ===== */'));
  if (!text) throw new Error('маркеры не найдены: ' + name);
  const s = text.indexOf('/* ===== ' + name + ' ');
  const e = text.indexOf('/* ===== end ' + name + ' ===== */');
  const code = text.slice(s, e);
  const names = Object.keys(deps);
  return new Function(...names, code + '\nreturn ' + name + ';')(...Object.values(deps));
}

module.exports = { extract, mainSrc };
