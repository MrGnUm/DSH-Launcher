#!/usr/bin/env node
// Юнит-тесты отчёта для поддержки (src/ui.js): reportFileName — имя архива,
// reportInfoText — сведения «ключ: значение».
'use strict';
const assert = require('assert');
const { reportFileName, reportInfoText } = require('../src/ui');

assert.strictEqual(reportFileName(new Date(2026, 0, 5, 9, 7)), 'dsh-launcher-report-20260105-0907.tar.gz', 'нули впереди');
assert.strictEqual(reportFileName(new Date(2026, 11, 31, 23, 59)), 'dsh-launcher-report-20261231-2359.tar.gz', 'конец года');

assert.strictEqual(reportInfoText([['a', '1'], ['b', 2]]), 'a: 1\nb: 2\n', 'ключ: значение');
assert.strictEqual(reportInfoText([['x', undefined], ['y', null], ['z', '']]), 'x: —\ny: —\nz: —\n', 'нет значения — «—»');
assert.strictEqual(reportInfoText([['n', 0]]), 'n: 0\n', 'ноль — значение');

console.log('OK: reportFileName, reportInfoText — все проверки прошли');
