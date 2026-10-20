import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncClock } from '../src/lib/clock.ts';

/** Um relógio local que o teste move à mão (ms). */
function fake() {
  let t = 1_000_000;
  const clock = createSyncClock({ now: () => t });
  return { clock, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

test('antes de qualquer mensagem da TV o relógio está em zero e parado', () => {
  const { clock, advance } = fake();
  advance(5000);
  assert.equal(clock.time(), 0);
});

test('anda sozinho entre as mensagens da TV, no ritmo do tempo real', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(10_000);
  advance(400);
  assert.ok(Math.abs(clock.time() - 10.4) < 0.001);
  advance(600);
  clock.position(11_000); // a próxima mensagem chega no instante certo: nada muda
  assert.ok(Math.abs(clock.time() - 11) < 0.001);
});

test('o atraso da rede não conta: vale a mensagem que menos atrasou', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  // cada mensagem informa a posição verdadeira (a TV estava em 10 s, 11 s, 12 s...), mas chega com atrasos diferentes
  const delays = [180, 40, 250, 90, 40, 300];
  let tvTime = 10_000;
  for (const delay of delays) {
    advance(1000);
    tvTime += 1000;
    // a mensagem foi enviada `delay` ms antes de chegar: quando chega, a música já está em tvTime + delay
    clock.position(tvTime - delay);
  }
  // o relógio da TV agora está em 16 s (10 + 6); o estimado fica a no máximo 40 ms dele (o menor atraso observado)
  assert.ok(Math.abs(clock.time() - 16) <= 0.05, String(clock.time()));
});

test('pausar congela, retomar continua dali e uma mensagem nova corrige', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(20_000);
  advance(500);
  clock.setPlaying(false);
  const frozen = clock.time();
  assert.ok(Math.abs(frozen - 20.5) < 0.001);
  advance(30_000); // ficou pausado muito tempo
  assert.equal(clock.time(), frozen);
  clock.setPlaying(true);
  assert.ok(Math.abs(clock.time() - frozen) < 0.001); // retomou do mesmo ponto
  advance(1000);
  clock.position(21_600); // a TV diz que retomou um pouco depois: o salto (>1,5 s? não: 0,1 s) é suavizado pela amostra
  assert.ok(Math.abs(clock.time() - 21.6) < 0.2);
});

test('um salto grande (o anfitrião adiantou a música) descarta as amostras velhas', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(5000);
  advance(1000);
  clock.position(6000);
  advance(1000);
  clock.position(90_000); // pulou para 1:30
  assert.ok(Math.abs(clock.time() - 90) < 0.001);
  advance(500);
  assert.ok(Math.abs(clock.time() - 90.5) < 0.001);
});

test('reset esquece tudo', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(30_000);
  clock.reset();
  advance(5000);
  assert.equal(clock.time(), 0);
  assert.equal(clock.playing, false);
});

test('valores inválidos viram zero em vez de quebrar', () => {
  const { clock } = fake();
  clock.setPlaying(true);
  clock.position('lixo');
  clock.position(-5);
  assert.ok(clock.time() >= 0);
});
