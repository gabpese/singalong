import assert from 'node:assert/strict';
import test from 'node:test';
import { nextUp, playOrder } from '../src/lib/queue-view.ts';
import { buildSearchQuery, embedUrl, extractVideoId, guessArtistTitle } from '../src/lib/youtube.ts';

type State = NonNullable<Parameters<typeof playOrder>[0]>;

const VID = 'dQw4w9WgXcQ';
const state = (value: { current_item_id: number | null; next_item_id: number | null; queue: { id: number }[] }) => value as unknown as State;

test("extractVideoId (the API's own rule)", () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${VID}&t=1`, `https://youtu.be/${VID}?si=x`, `https://music.youtube.com/watch?v=${VID}`,
    `https://www.youtube.com/shorts/${VID}`, `https://m.youtube.com/embed/${VID}`, `youtu.be/${VID}`, `www.youtube.com/watch?v=${VID}`, VID,
  ]) {
    assert.equal(extractVideoId(url), VID, url);
  }
  for (const url of ['', 'https://example.com/watch?v=' + VID, 'https://youtu.be/short', 'jack lament', 'https://www.youtube.com/watch', undefined]) {
    assert.equal(extractVideoId(url), null, String(url));
  }
});

test('embedUrl uses the domain without tracking cookies', () => {
  assert.equal(embedUrl(VID), `https://www.youtube-nocookie.com/embed/${VID}?autoplay=1&rel=0&playsinline=1`);
});

test("nextUp: the server's choice; otherwise the first one waiting, marked as preparing", () => {
  const queue = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(nextUp(state({ current_item_id: 1, next_item_id: 3, queue })), { item: { id: 3 }, preparing: false });
  assert.deepEqual(nextUp(state({ current_item_id: 1, next_item_id: null, queue })), { item: { id: 2 }, preparing: true });
  assert.equal(nextUp(state({ current_item_id: 1, next_item_id: null, queue: [{ id: 1 }] })), null);
  assert.equal(nextUp(state({ current_item_id: null, next_item_id: null, queue: [] })), null);
  assert.deepEqual(nextUp(state({ current_item_id: null, next_item_id: 2, queue })), { item: { id: 2 }, preparing: false });
});

test("playOrder: the next one the server chose comes first; the rest follows the Queue", () => {
  const queue = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepEqual(playOrder(state({ current_item_id: 1, next_item_id: 3, queue })), { current: { id: 1 }, upcoming: [{ id: 3 }, { id: 2 }, { id: 4 }] });
  assert.deepEqual(playOrder(state({ current_item_id: 1, next_item_id: 2, queue })).upcoming.map((i) => i.id), [2, 3, 4]);
  // none ready: the Queue's order, without making up a "next"
  assert.deepEqual(playOrder(state({ current_item_id: 1, next_item_id: null, queue })).upcoming.map((i) => i.id), [2, 3, 4]);
  assert.deepEqual(playOrder(state({ current_item_id: null, next_item_id: null, queue: [] })), { current: null, upcoming: [] });
  assert.deepEqual(playOrder(null), { current: null, upcoming: [] });
});

test('buildSearchQuery: "Artist - Song name" or only one of them, with the spaces normalized', () => {
  assert.equal(buildSearchQuery('Faouzia', 'Unethical'), 'Faouzia - Unethical');
  assert.equal(buildSearchQuery('  Bring Me  The Horizon ', '\tLosT\n'), 'Bring Me The Horizon - LosT');
  assert.equal(buildSearchQuery('Danny Elfman', "Jack's Lament"), "Danny Elfman - Jack's Lament"); // quotes and accents intact
  assert.equal(buildSearchQuery('Faouzia', ''), 'Faouzia'); // only the artist
  assert.equal(buildSearchQuery('', '  Unethical '), 'Unethical'); // only the song's name
  assert.equal(buildSearchQuery('   ', ''), null);
  assert.equal(buildSearchQuery(undefined, undefined), null);
});

test("guessArtistTitle: the artist and the name from the video's title, without YouTube's trimmings", () => {
  const guess = (title: string | undefined) => guessArtistTitle(title);
  assert.deepEqual(guess('Faouzia - UNETHICAL (Official Music Video)'), { artist: 'Faouzia', title: 'UNETHICAL' });
  assert.deepEqual(guess('Avi Kaplan - "First Place I Go" (Official Lyric Video)'), { artist: 'Avi Kaplan', title: 'First Place I Go' });
  assert.deepEqual(guess('Stone Sour - Through Glass [OFFICIAL VIDEO]'), { artist: 'Stone Sour', title: 'Through Glass' });
  assert.deepEqual(guess('Stone Sour - Wicked Game Lyrics'), { artist: 'Stone Sour', title: 'Wicked Game' });
  assert.deepEqual(guess('Daft Punk - Harder, Better, Faster, Stronger (Official Audio)'), { artist: 'Daft Punk', title: 'Harder, Better, Faster, Stronger' });
  // what is not a trimming stays: whoever asked checks and corrects it
  assert.deepEqual(guess('Faouzia - Unethical (MAPHRA Vocal Cover)'), { artist: 'Faouzia', title: 'Unethical (MAPHRA Vocal Cover)' });
  assert.deepEqual(guess('Metallica – Nothing Else Matters'), { artist: 'Metallica', title: 'Nothing Else Matters' }); // an en dash
  assert.deepEqual(guess('Shadow (Remix)'), { artist: '', title: 'Shadow (Remix)' }); // "hd" inside a word does not count
  assert.deepEqual(guess('Unethical'), { artist: '', title: 'Unethical' }); // no " - ": it is all the name
  assert.deepEqual(guess(undefined), { artist: '', title: '' });
});
