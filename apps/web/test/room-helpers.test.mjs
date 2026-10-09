import assert from 'node:assert/strict';
import test from 'node:test';
import { newClientId, parseHostHash, parseRoomCode } from '../src/lib/identity.js';
import { canRetry, formatDuration, formatPitch, progressPercent, playOrder, songChip, splitQueue } from '../src/lib/queue-view.js';

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

test('normalizeText: sem acentos, minúsculas e espaços normalizados', async () => {
  const { normalizeText } = await import('../src/lib/queue-view.js');
  assert.equal(normalizeText('  Dó♯  RÉ  Fá '), 'do♯ re fa');
  assert.equal(normalizeText('Ação'), 'acao');
  assert.equal(normalizeText(null), '');
});

const library = [
  { video_id: 'a', title: "Jack's Lament", artist: 'Danny Elfman' },
  { video_id: 'b', title: 'Unethical', artist: 'Faouzia' },
  { video_id: 'c', title: 'LosT', artist: 'Bring Me The Horizon' },
  { video_id: 'd', title: 'O Cantor e o Taxista', artist: null }, // sem artista
  { video_id: 'e', title: 'Ré menor', artist: 'Alguém' },
];

test('filterSongs: artista ou nome, sem acento nem maiúsculas, várias palavras em qualquer ordem', async () => {
  const { filterSongs } = await import('../src/lib/queue-view.js');
  const ids = (q) => filterSongs(library, q).map((s) => s.video_id);
  assert.deepEqual(ids(''), ['a', 'b', 'c', 'd', 'e']); // vazio: tudo
  assert.deepEqual(ids('   '), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids('faouzia'), ['b']); // por artista
  assert.deepEqual(ids('UNETHICAL'), ['b']); // por nome, maiúsculas
  assert.deepEqual(ids('jack'), ['a']);
  assert.deepEqual(ids('elfman jack'), ['a']); // palavras em qualquer ordem
  assert.deepEqual(ids('bring horizon'), ['c']);
  assert.deepEqual(ids('re menor'), ['e']); // "Ré" sem acento
  assert.deepEqual(ids('alguem'), ['e']); // "Alguém" sem acento
  assert.deepEqual(ids('taxista'), ['d']); // música sem artista continua achável
  assert.deepEqual(ids('lost'), ['c']);
  assert.deepEqual(ids('xyz'), []); // nada
  assert.deepEqual(ids('faouzia jack'), []); // todas as palavras precisam casar
  assert.equal(filterSongs(library, '') , library); // sem filtro devolve a própria lista
});

test('sortSongs: por artista e depois por nome, sem alterar a lista original', async () => {
  const { sortSongs } = await import('../src/lib/queue-view.js');
  const sorted = sortSongs(library).map((s) => s.video_id);
  assert.deepEqual(sorted, ['e', 'c', 'a', 'b', 'd']); // Alguém, Bring, Danny, Faouzia e, por último, a sem artista
  assert.deepEqual(library.map((s) => s.video_id), ['a', 'b', 'c', 'd', 'e']);
  // mesmo artista: desempata pelo nome (sem diferenciar maiúsculas nem acentos)
  const sameArtist = [{ video_id: '1', artist: 'X', title: 'Zebra' }, { video_id: '2', artist: 'x', title: 'Água' }, { video_id: '3', artist: 'X', title: 'Beta' }];
  assert.deepEqual(sortSongs(sameArtist).map((s) => s.video_id), ['2', '3', '1']);
  // duas sem artista: ordem pelo nome
  assert.deepEqual(sortSongs([{ video_id: 'q', title: 'B' }, { video_id: 'w', title: 'A' }]).map((s) => s.video_id), ['w', 'q']);
});

test('canRetry: só oferece "Tentar de novo" quando vale a pena', () => {
  assert.equal(canRetry({ status: 'failed', retry: 'manual' }), true);
  assert.equal(canRetry({ status: 'failed', retry: null }), true);
  assert.equal(canRetry({ status: 'failed', retry: 'never' }), false); // privado, bloqueado, longo demais...
  assert.equal(canRetry({ status: 'ready' }), false);
  assert.equal(songChip({ status: 'processing', stage: 'retrying' }).label, 'Tentando de novo…');
});

test('wordFills: usa os tempos reais de cada palavra e cai na estimativa quando não há', async () => {
  const { wordFills } = await import('../src/lib/lyrics-sync.js');
  const cue = { start: 1, end: 4, text: 'Lock me up', words: [[1, 2], [2.5, 3], [3, 4]] };
  assert.deepEqual(wordFills(cue, 3, 0), [0, 0, 0]);
  assert.deepEqual(wordFills(cue, 3, 1.5), [0.5, 0, 0]);
  assert.deepEqual(wordFills(cue, 3, 2.75), [1, 0.5, 0]); // pausa entre palavras: a segunda ainda não começou
  assert.deepEqual(wordFills(cue, 3, 9), [1, 1, 1]);
  assert.equal(wordFills({ ...cue, words: undefined }, 3, 2), null); // letra sem tempos por palavra
  assert.equal(wordFills(cue, 4, 2), null); // contagem não bate (texto editado): não arrisca
  assert.deepEqual(wordFills({ words: [[2, 2]] }, 1, 1), [0]); // palavra sem duração
  assert.deepEqual(wordFills({ words: [[2, 2]] }, 1, 3), [1]);
});

test('playOrder: com play_order do servidor (rodízio justo) a lista segue essa ordem', () => {
  const queue = [1, 2, 3, 4].map((id) => ({ id }));
  const state = { queue, current_item_id: null, play_order: [1, 2, 4, 3] };
  assert.deepEqual(playOrder(state).upcoming.map((i) => i.id), [1, 2, 4, 3]);
});
