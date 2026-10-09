import assert from 'node:assert/strict';
import test from 'node:test';
import { embedUrl, extractVideoId } from '../public/youtube.js';
import { nextUp, playOrder } from '../public/queue-view.js';

const VID = 'dQw4w9WgXcQ';

test('extractVideoId (mesma regra da API)', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${VID}&t=1`, `https://youtu.be/${VID}?si=x`, `https://music.youtube.com/watch?v=${VID}`,
    `https://www.youtube.com/shorts/${VID}`, `https://m.youtube.com/embed/${VID}`, `youtu.be/${VID}`, `www.youtube.com/watch?v=${VID}`, VID,
  ]) {
    assert.equal(extractVideoId(url), VID, url);
  }
  for (const url of ['', 'https://example.com/watch?v=' + VID, 'https://youtu.be/curto', 'jack lament', 'https://www.youtube.com/watch', undefined]) {
    assert.equal(extractVideoId(url), null, String(url));
  }
});

test('embedUrl usa o domínio sem cookies de rastreio', () => {
  assert.equal(embedUrl(VID), `https://www.youtube-nocookie.com/embed/${VID}?autoplay=1&rel=0&playsinline=1`);
});

test('nextUp: o escolhido pelo servidor; senão o primeiro que espera, marcado como preparando', () => {
  const queue = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(nextUp({ current_item_id: 1, next_item_id: 3, queue }), { item: { id: 3 }, preparing: false });
  assert.deepEqual(nextUp({ current_item_id: 1, next_item_id: null, queue }), { item: { id: 2 }, preparing: true });
  assert.equal(nextUp({ current_item_id: 1, next_item_id: null, queue: [{ id: 1 }] }), null);
  assert.equal(nextUp({ current_item_id: null, next_item_id: null, queue: [] }), null);
  assert.deepEqual(nextUp({ current_item_id: null, next_item_id: 2, queue }), { item: { id: 2 }, preparing: false });
});

test('playOrder: o próximo escolhido pelo servidor vem na frente; o resto segue a fila', () => {
  const queue = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepEqual(playOrder({ current_item_id: 1, next_item_id: 3, queue }), { current: { id: 1 }, upcoming: [{ id: 3 }, { id: 2 }, { id: 4 }] });
  assert.deepEqual(playOrder({ current_item_id: 1, next_item_id: 2, queue }).upcoming.map((i) => i.id), [2, 3, 4]);
  // nenhum pronto: ordem da fila, sem inventar um "próximo"
  assert.deepEqual(playOrder({ current_item_id: 1, next_item_id: null, queue }).upcoming.map((i) => i.id), [2, 3, 4]);
  assert.deepEqual(playOrder({ current_item_id: null, next_item_id: null, queue: [] }), { current: null, upcoming: [] });
  assert.deepEqual(playOrder(null), { current: null, upcoming: [] });
});

test('buildSearchQuery: "Artista - Nome da música", com espaços normalizados e os dois campos obrigatórios', async () => {
  const { buildSearchQuery } = await import('../public/youtube.js');
  assert.equal(buildSearchQuery('Faouzia', 'Unethical'), 'Faouzia - Unethical');
  assert.equal(buildSearchQuery('  Bring Me  The Horizon ', "\tLosT\n"), 'Bring Me The Horizon - LosT');
  assert.equal(buildSearchQuery('Danny Elfman', "Jack's Lament"), "Danny Elfman - Jack's Lament"); // aspas e acentos intactos
  assert.equal(buildSearchQuery('Faouzia', ''), null);
  assert.equal(buildSearchQuery('', 'Unethical'), null);
  assert.equal(buildSearchQuery('   ', 'x'), null);
  assert.equal(buildSearchQuery(undefined, undefined), null);
});
