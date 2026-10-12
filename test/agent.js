#!/usr/bin/env node
// Юнит-тесты сигнала «агент закончил / ждёт вас» (src/ui.js): agentEvent —
// что изменилось в GUI dsh между двумя проверками.
'use strict';
const assert = require('assert');
const { agentEvent } = require('../src/ui');

const s = (running, waiting = null) => ({ running, waiting });

assert.strictEqual(agentEvent(s(false), s(false)), null, 'ничего не происходит');
assert.strictEqual(agentEvent(s(false), s(true)), null, 'начал отвечать — не сообщаем');
assert.deepStrictEqual(agentEvent(s(true), s(false)), { type: 'finished' }, 'закончил ответ');
assert.deepStrictEqual(agentEvent(s(true), s(true, 'approval')), { type: 'waiting', kind: 'approval' }, 'ждёт подтверждения команды');
assert.deepStrictEqual(agentEvent(s(true), s(false, 'question')), { type: 'waiting', kind: 'question' }, 'задал вопрос (ответ остановлен)');
assert.deepStrictEqual(agentEvent(s(false), s(false, 'plan')), { type: 'waiting', kind: 'plan' }, 'ждёт согласования плана');
assert.strictEqual(agentEvent(s(true, 'approval'), s(true, 'approval')), null, 'то же ожидание — повторно не сообщаем');
assert.deepStrictEqual(agentEvent(s(true, 'approval'), s(true, 'question')), { type: 'waiting', kind: 'question' }, 'новое ожидание другого вида');
assert.strictEqual(agentEvent(s(true, 'approval'), s(true)), null, 'подтвердили — агент продолжает');
assert.deepStrictEqual(agentEvent(s(true, 'approval'), s(false)), { type: 'finished' }, 'подтвердили, и ответ закончен');
assert.strictEqual(agentEvent(s(false, 'question'), s(false)), null, 'ответили на вопрос, агент ещё не начал');

console.log('OK: agentEvent — все проверки прошли');

// ---- crashRestart: перезапускать ли dsh после сбоя ----
{
  const { crashRestart } = require('../src/ui');
  const M = 60 * 1000;
  let r = crashRestart([], 0, 1, null);
  assert.deepStrictEqual(r, { restart: true, history: [0] }, 'упал (код 1) — перезапуск');
  assert.strictEqual(crashRestart([], 0, null, 'SIGSEGV').restart, true, 'упал по сигналу — перезапуск');
  assert.strictEqual(crashRestart([], 0, 0, null).restart, false, 'штатный выход (код 0) — не перезапускать');
  r = crashRestart([0, 1 * M], 2 * M, 1, null);
  assert.deepStrictEqual(r, { restart: true, history: [0, 1 * M, 2 * M] }, 'третий раз за 10 минут — ещё можно');
  r = crashRestart([0, 1 * M, 2 * M], 3 * M, 1, null);
  assert.strictEqual(r.restart, false, 'четвёртый за 10 минут — хватит');
  r = crashRestart([0, 1 * M, 2 * M], 11 * M, 1, null);
  assert.deepStrictEqual(r, { restart: true, history: [2 * M, 11 * M] }, 'старые (больше 10 минут назад) не считаются');
  assert.strictEqual(crashRestart(null, 0, 1, null).restart, true, 'нет истории');
  console.log('OK: crashRestart — все проверки прошли');
}
