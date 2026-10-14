import assert from 'node:assert/strict';
import test from 'node:test';
import { blockRms, createGate, GATE, rmsToDb } from '../src/lib/voice-gate.js';

const rmsOf = (db) => 10 ** (db / 20);

test('rmsToDb e blockRms: o volume em dBFS e o RMS de um bloco', () => {
  assert.equal(rmsToDb(1), 0);
  assert.ok(Math.abs(rmsToDb(0.5) + 6.02) < 0.01);
  assert.equal(rmsToDb(0), -Infinity);
  assert.equal(blockRms([]), 0);
  assert.ok(Math.abs(blockRms([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-12);
});

test('o portão começa fechado, abre com voz e a pausa entre palavras não o fecha', () => {
  const gate = createGate();
  assert.equal(gate.target(rmsOf(-70), 0), GATE.floor); // só ruído da sala
  assert.equal(gate.target(rmsOf(-30), 50), 1); // a voz entrou: abre na hora
  assert.equal(gate.target(rmsOf(-70), 150), 1); // silêncio curto (uma pausa): ainda aberto
  assert.equal(gate.target(rmsOf(-70), 300), 1);
  assert.equal(gate.target(rmsOf(-70), 50 + GATE.holdMs + 10), GATE.floor); // passou o tempo de espera: fecha
});

test('voz fraca (entre os dois limites) mantém o portão aberto, sem abrir e fechar a cada quadro', () => {
  const gate = createGate();
  gate.target(rmsOf(-30), 0); // abre
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 50;
    assert.equal(gate.target(rmsOf(-49), t), 1); // entre -52 e -46: continua aberto, e renova a espera
  }
  assert.equal(gate.target(rmsOf(-49), t + 5000), 1); // mesmo muito tempo depois, a voz fraca segura
  // mas um ruído nesse mesmo nível NÃO abre um portão que estava fechado
  const closed = createGate();
  assert.equal(closed.target(rmsOf(-49), 0), GATE.floor);
});

test('depois de fechado, só abre de novo acima do limite de abertura', () => {
  const gate = createGate();
  gate.target(rmsOf(-30), 0);
  gate.target(rmsOf(-80), 1000); // fecha
  assert.equal(gate.open, false);
  assert.equal(gate.target(rmsOf(-48), 1100), GATE.floor); // abaixo do limite de abertura
  assert.equal(gate.target(rmsOf(-40), 1200), 1); // a voz voltou
});
