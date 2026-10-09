import assert from 'node:assert/strict';
import test from 'node:test';
import { newClientId, parseHostHash, parseRoomCode } from '../public/identity.js';
import { formatDuration, formatPitch, progressPercent, songChip, splitQueue } from '../public/queue-view.js';

test('newClientId: formato aceito pela API e sem depender de crypto.randomUUID', () => {
  const id = newClientId((bytes) => bytes.map((_, i) => i * 7));
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(newClientId((b) => b.fill(255)), 'c' + 'ff'.repeat(12));
});

test('parseRoomCode: maiúsculas, tamanho válido e nada de lixo', () => {
  assert.equal(parseRoomCode('?room=k7qm'), 'K7QM');
  assert.equal(parseRoomCode('?x=1&room=ABCD'), 'ABCD');
  assert.equal(parseRoomCode('?room=ab'), null);
  assert.equal(parseRoomCode('?room=<script>'), null);
  assert.equal(parseRoomCode(''), null);
});

test('parseHostHash', () => {
  assert.equal(parseHostHash('#host=abc123DEF'), 'abc123DEF');
  assert.equal(parseHostHash('#x=1&host=tok9'), 'tok9');
  assert.equal(parseHostHash('#host='), null);
  assert.equal(parseHostHash(''), null);
});

test('songChip: o que a pessoa lê para cada estado da música', () => {
  assert.deepEqual(songChip({ status: 'ready', ready: true }), { label: 'Pronta', kind: 'ok' });
  assert.deepEqual(songChip({ status: 'pending' }), { label: 'Na fila de processamento', kind: 'busy' });
  assert.deepEqual(songChip({ status: 'processing', stage: 'separating' }), { label: 'Separando a voz…', kind: 'busy' });
  assert.deepEqual(songChip({ status: 'processing', stage: 'aligning' }), { label: 'Sincronizando a letra…', kind: 'busy' });
  assert.deepEqual(songChip({ status: 'processing' }), { label: 'Processando…', kind: 'busy' });
  assert.deepEqual(songChip({ status: 'needs_lyrics' }), { label: 'Precisa de letra', kind: 'warn' });
  assert.deepEqual(songChip({ status: 'failed' }), { label: 'Falhou', kind: 'error' });
  assert.equal(songChip(undefined).kind, 'busy');
  // pronta mas com um job de nova letra rodando: o estado do job é o que importa
  assert.equal(songChip({ status: 'processing', stage: 'aligning', ready: true }).kind, 'busy');
});

test('formatDuration, formatPitch e progressPercent', () => {
  assert.equal(formatDuration(222.4), '3:42');
  assert.equal(formatDuration(undefined), '0:00');
  assert.equal(formatPitch(3), '+3');
  assert.equal(formatPitch(-2), '-2');
  assert.equal(formatPitch(0), '0');
  assert.equal(progressPercent(50_000, 200), 25);
  assert.equal(progressPercent(999_999, 200), 100);
  assert.equal(progressPercent(5000, 0), 0);
});

test('splitQueue: o atual vem separado dos que aguardam', () => {
  const state = { current_item_id: 2, queue: [{ id: 2 }, { id: 5 }, { id: 9 }] };
  assert.deepEqual(splitQueue(state), { current: { id: 2 }, waiting: [{ id: 5 }, { id: 9 }] });
  assert.deepEqual(splitQueue({ current_item_id: null, queue: [{ id: 1 }] }), { current: null, waiting: [{ id: 1 }] });
  assert.deepEqual(splitQueue(null), { current: null, waiting: [] });
});
