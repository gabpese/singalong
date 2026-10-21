import assert from 'node:assert/strict';
import test from 'node:test';
import { newClientId, parseHostHash, parseRoomCode } from '../src/lib/identity.ts';
import { wordFills } from '../src/lib/lyrics-sync.ts';
import type { SongView } from '../src/lib/types.ts';
import { canRetry, filterSongs, findJukeboxMatches, formatDuration, formatPitch, normalizeText, playOrder, progressPercent, songChip, sortSongs, splitQueue } from '../src/lib/queue-view.ts';

type State = NonNullable<Parameters<typeof playOrder>[0]>;
type JukeboxSong = { video_id: string; artist?: string | null; title?: string | null; video_title?: string | null };
type Cue = Parameters<typeof wordFills>[0];

const song = (value: Record<string, unknown>) => value as unknown as SongView;
const state = (value: Record<string, unknown>) => value as unknown as State;
const songs = (value: JukeboxSong[]) => value;
const ids = (list: readonly { video_id?: string }[]) => list.map((s) => s.video_id);

test('newClientId: a format the API accepts, without relying on crypto.randomUUID', () => {
  const id = newClientId((bytes) => bytes.map((_, i) => i * 7));
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(newClientId((b) => b.fill(255)), 'c' + 'ff'.repeat(12));
});

test('parseRoomCode: capitals, a valid size and no junk', () => {
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

test("songChip: what the person reads for each of the song's states", () => {
  assert.deepEqual(songChip(song({ status: 'ready', ready: true })), { label: 'Pronta', kind: 'ok' });
  assert.deepEqual(songChip(song({ status: 'pending' })), { label: 'Esperando a vez no palco', kind: 'busy' });
  assert.deepEqual(songChip(song({ status: 'processing', stage: 'separating' })), { label: 'Isolando a banda…', kind: 'busy' });
  assert.deepEqual(songChip(song({ status: 'processing', stage: 'aligning' })), { label: 'Afinando os microfones…', kind: 'busy' });
  assert.deepEqual(songChip(song({ status: 'processing' })), { label: 'Montando o palco…', kind: 'busy' });
  assert.deepEqual(songChip(song({ status: 'needs_lyrics' })), { label: 'Falta a letra', kind: 'warn' });
  assert.deepEqual(songChip(song({ status: 'failed' })), { label: 'Falhou', kind: 'error' });
  assert.equal(songChip(undefined).kind, 'busy');
  // ready, but with a new-lyrics job running: the job's state is what matters
  assert.equal(songChip(song({ status: 'processing', stage: 'aligning', ready: true })).kind, 'busy');
});

test('formatDuration, formatPitch and progressPercent', () => {
  assert.equal(formatDuration(222.4), '3:42');
  assert.equal(formatDuration(undefined), '0:00');
  assert.equal(formatPitch(3), '+3');
  assert.equal(formatPitch(-2), '-2');
  assert.equal(formatPitch(0), '0');
  assert.equal(progressPercent(50_000, 200), 25);
  assert.equal(progressPercent(999_999, 200), 100);
  assert.equal(progressPercent(5000, 0), 0);
});

test('splitQueue: the current one comes apart from those waiting', () => {
  assert.deepEqual(splitQueue(state({ current_item_id: 2, queue: [{ id: 2 }, { id: 5 }, { id: 9 }] })), { current: { id: 2 }, waiting: [{ id: 5 }, { id: 9 }] });
  assert.deepEqual(splitQueue(state({ current_item_id: null, queue: [{ id: 1 }] })), { current: null, waiting: [{ id: 1 }] });
  assert.deepEqual(splitQueue(null), { current: null, waiting: [] });
});

test('normalizeText: no accents, lowercase and normalized spaces', () => {
  assert.equal(normalizeText('  Dó♯  RÉ  Fá '), 'do♯ re fa');
  assert.equal(normalizeText('Ação'), 'acao');
  assert.equal(normalizeText(null), '');
});

const library = songs([
  { video_id: 'a', title: "Jack's Lament", artist: 'Danny Elfman' },
  { video_id: 'b', title: 'Unethical', artist: 'Faouzia' },
  { video_id: 'c', title: 'LosT', artist: 'Bring Me The Horizon' },
  { video_id: 'd', title: 'O Cantor e o Taxista', artist: null }, // no artist
  { video_id: 'e', title: 'Ré menor', artist: 'Alguém' },
]);

test('filterSongs: artist or name, ignoring accents and capitals, several words in any order', () => {
  const found = (q: string) => ids(filterSongs(library, q));
  assert.deepEqual(found(''), ['a', 'b', 'c', 'd', 'e']); // empty: everything
  assert.deepEqual(found('   '), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(found('faouzia'), ['b']); // by artist
  assert.deepEqual(found('UNETHICAL'), ['b']); // by name, in capitals
  assert.deepEqual(found('jack'), ['a']);
  assert.deepEqual(found('elfman jack'), ['a']); // words in any order
  assert.deepEqual(found('bring horizon'), ['c']);
  assert.deepEqual(found('re menor'), ['e']); // "Ré" without the accent
  assert.deepEqual(found('alguem'), ['e']); // "Alguém" without the accent
  assert.deepEqual(found('taxista'), ['d']); // a song without an artist can still be found
  assert.deepEqual(found('lost'), ['c']);
  assert.deepEqual(found('xyz'), []); // nothing
  assert.deepEqual(found('faouzia jack'), []); // every word must match
  assert.equal(filterSongs(library, ''), library); // without a filter it answers the list itself
});

test('sortSongs: by artist and then by name, without changing the original list', () => {
  assert.deepEqual(ids(sortSongs(library)), ['e', 'c', 'a', 'b', 'd']); // Alguém, Bring, Danny, Faouzia and, last, the one without an artist
  assert.deepEqual(ids(library), ['a', 'b', 'c', 'd', 'e']);
  // the same artist: the name breaks the tie (ignoring capitals and accents)
  const sameArtist = songs([{ video_id: '1', artist: 'X', title: 'Zebra' }, { video_id: '2', artist: 'x', title: 'Água' }, { video_id: '3', artist: 'X', title: 'Beta' }]);
  assert.deepEqual(ids(sortSongs(sameArtist)), ['2', '3', '1']);
  // two without an artist: ordered by name
  assert.deepEqual(ids(sortSongs(songs([{ video_id: 'q', title: 'B' }, { video_id: 'w', title: 'A' }]))), ['w', 'q']);
});

test('canRetry: offers "Tentar de novo" only when it is worth it', () => {
  assert.equal(canRetry(song({ status: 'failed', retry: 'manual' })), true);
  assert.equal(canRetry(song({ status: 'failed', retry: null })), true);
  assert.equal(canRetry(song({ status: 'failed', retry: 'never' })), false); // private, blocked, too long...
  assert.equal(canRetry(song({ status: 'ready' })), false);
  assert.equal(songChip(song({ status: 'processing', stage: 'retrying' })).label, 'Passando o som de novo…');
});

test("wordFills: uses each word's real times and falls back to the estimate when there are none", () => {
  const cue = { start: 1, end: 4, text: 'Lock me up', words: [[1, 2], [2.5, 3], [3, 4]] } as Cue;
  assert.deepEqual(wordFills(cue, 3, 0), [0, 0, 0]);
  assert.deepEqual(wordFills(cue, 3, 1.5), [0.5, 0, 0]);
  assert.deepEqual(wordFills(cue, 3, 2.75), [1, 0.5, 0]); // a pause between words: the second has not started yet
  assert.deepEqual(wordFills(cue, 3, 9), [1, 1, 1]);
  assert.equal(wordFills({ ...cue, words: undefined }, 3, 2), null); // lyrics without times per word
  assert.equal(wordFills(cue, 4, 2), null); // the count does not match (edited text): it does not risk it
  assert.deepEqual(wordFills({ words: [[2, 2]] } as Cue, 1, 1), [0]); // a word without a duration
  assert.deepEqual(wordFills({ words: [[2, 2]] } as Cue, 1, 3), [1]);
});

test("playOrder: with the server's play_order (the fair rotation) the list follows that order", () => {
  const queue = [1, 2, 3, 4].map((id) => ({ id }));
  assert.deepEqual(playOrder(state({ queue, current_item_id: null, play_order: [1, 2, 4, 3] })).upcoming.map((i) => i.id), [1, 2, 4, 3]);
});

test("findJukeboxMatches: finds the ready versions by the artist's and the name's words, ignoring accents and punctuation", () => {
  const jukebox = songs([
    { video_id: 'a', artist: 'Faouzia', title: 'Unethical' },
    { video_id: 'b', artist: 'Faouzia', title: 'Unethical (Acoustic)' },
    { video_id: 'c', artist: 'Stone Sour', title: "Don't Stop" },
    { video_id: 'd', artist: 'Adele', title: 'Rolling in the Deep' },
    { video_id: 'e', artist: null, title: 'Unethical — cover' },
  ]);
  const found = (artist: string, title: string) => ids(findJukeboxMatches(jukebox, artist, title));
  assert.deepEqual(found('faouzia', 'unethical'), ['a', 'b']); // more than one version
  assert.deepEqual(found('Adele', 'rolling in the deep'), ['d']);
  assert.deepEqual(found('stone sour', 'DONT STOP'), ['c']); // the apostrophe and the capitals are no obstacle
  assert.deepEqual(found('Adèle', 'Rolling Deep'), ['d']); // an accent and missing words (the order does not matter)
  assert.deepEqual(found('Faouzia', 'Unethical Acoustic'), ['b']);
  assert.deepEqual(found('Faouz', 'Unethical'), []); // half a word does not count
  assert.deepEqual(found('Billie Eilish', 'Bad Guy'), []);
  assert.deepEqual(found('', 'Unethical'), ['a', 'b', 'e']); // only the song's name
  assert.deepEqual(found('Faouzia', '  '), ['a', 'b']); // only the artist
  assert.deepEqual(found('  ', ''), []); // neither of the two: it suggests nothing
});

test("findJukeboxMatches and filterSongs also look at the YouTube video's original title", () => {
  const jukebox = songs([
    // asked for as "Faouzia — Unethical", but the video is called "... (MAPHRA Vocal Cover)"
    { video_id: 'a', artist: 'Faouzia', title: 'Unethical', video_title: 'Faouzia - Unethical (MAPHRA Vocal Cover)' },
    { video_id: 'b', artist: 'Faouzia', title: 'Unethical', video_title: 'Faouzia - UNETHICAL (Official Music Video)' },
    { video_id: 'c', artist: 'Adele', title: 'Rolling in the Deep' }, // an old song, without video_title
  ]);
  const found = (artist: string, title: string) => ids(findJukeboxMatches(jukebox, artist, title));
  assert.deepEqual(found('Faouzia', 'Unethical'), ['a', 'b']);
  assert.deepEqual(found('Maphra', 'Unethical'), ['a']); // another name for the same song: it still finds it
  assert.deepEqual(found('Maphra', 'Vocal Cover'), ['a']);
  assert.deepEqual(found('Adele', 'Rolling in the Deep'), ['c']); // without video_title it still works
  assert.deepEqual(found('Official', 'Unethical').sort(), ['b']);
  assert.deepEqual(ids(filterSongs(jukebox, 'maphra')), ['a']);
  assert.deepEqual(ids(filterSongs(jukebox, 'official music')), ['b']);
});
