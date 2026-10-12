'use strict';
// Статическая проверка (npm run lint; входит в npm test): неизвестные имена,
// неиспользуемые переменные и импорты, недостижимый код и т. п. — то, что
// иначе всплывает только при запуске (потерянный импорт, ссылка на имя,
// которого больше нет).
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'test/docker/', 'logs/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
