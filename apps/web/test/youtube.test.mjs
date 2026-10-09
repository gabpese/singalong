import assert from 'node:assert/strict';
import test from 'node:test';
import { embedUrl, extractVideoId } from '../src/lib/youtube.js';
import { nextUp, playOrder } from '../src/lib/queue-view.js';

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

test('buildSearchQuery: "Artista - Nome da música" ou só um dos dois, com espaços normalizados', async () => {
  const { buildSearchQuery } = await import('../src/lib/youtube.js');
  assert.equal(buildSearchQuery('Faouzia', 'Unethical'), 'Faouzia - Unethical');
  assert.equal(buildSearchQuery('  Bring Me  The Horizon ', '\tLosT\n'), 'Bring Me The Horizon - LosT');
  assert.equal(buildSearchQuery('Danny Elfman', "Jack's Lament"), "Danny Elfman - Jack's Lament"); // aspas e acentos intactos
  assert.equal(buildSearchQuery('Faouzia', ''), 'Faouzia'); // só o artista
  assert.equal(buildSearchQuery('', '  Unethical '), 'Unethical'); // só o nome da música
  assert.equal(buildSearchQuery('   ', ''), null);
  assert.equal(buildSearchQuery(undefined, undefined), null);
});

test('guessArtistTitle: artista e nome a partir do título do vídeo, sem os enfeites do YouTube', async () => {
  const { guessArtistTitle } = await import('../src/lib/youtube.js');
  const guess = (title) => guessArtistTitle(title);
  assert.deepEqual(guess('Faouzia - UNETHICAL (Official Music Video)'), { artist: 'Faouzia', title: 'UNETHICAL' });
  assert.deepEqual(guess('Avi Kaplan - "First Place I Go" (Official Lyric Video)'), { artist: 'Avi Kaplan', title: 'First Place I Go' });
  assert.deepEqual(guess('Stone Sour - Through Glass [OFFICIAL VIDEO]'), { artist: 'Stone Sour', title: 'Through Glass' });
  assert.deepEqual(guess('Stone Sour - Wicked Game Lyrics'), { artist: 'Stone Sour', title: 'Wicked Game' });
  assert.deepEqual(guess('Daft Punk - Harder, Better, Faster, Stronger (Official Audio)'), { artist: 'Daft Punk', title: 'Harder, Better, Faster, Stronger' });
  // o que não é enfeite fica: quem pediu confere e corrige
  assert.deepEqual(guess('Faouzia - Unethical (MAPHRA Vocal Cover)'), { artist: 'Faouzia', title: 'Unethical (MAPHRA Vocal Cover)' });
  assert.deepEqual(guess('Metallica – Nothing Else Matters'), { artist: 'Metallica', title: 'Nothing Else Matters' }); // travessão
  assert.deepEqual(guess('Shadow (Remix)'), { artist: '', title: 'Shadow (Remix)' }); // "hd" dentro de uma palavra não conta
  assert.deepEqual(guess('Unethical'), { artist: '', title: 'Unethical' }); // sem " - ": tudo é o nome
  assert.deepEqual(guess(undefined), { artist: '', title: '' });
});

