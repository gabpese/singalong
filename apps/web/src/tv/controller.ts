// The TV's controller: connects the Room (WebSocket) to the audio engine and the scoring. It draws nothing: it tells the screen through `ui`.
// The TV plays what the Room sends (the server owns the Queue), says when the song ends, and sends the position to the phones.
import { t } from '../i18n/index.ts';
import { createEngine } from '../lib/engine.ts';
import { clampLatency, loadLatency, saveLatency, sungPosition } from '../lib/latency.ts';
import { loadMics, loadVoiceFilter, micsKey, openVoice, saveMics, saveVoiceFilter, voiceGain } from '../lib/voice.ts';
import { connectRoom } from '../lib/identity.ts';
import { splitQueue } from '../lib/queue-view.ts';
import { type MelodyNote, melodyNotes, pushTrail } from '../lib/melody-guide.ts';
import { partAtTime, singsAt, splitParts } from '../lib/duet.ts';
import { createScorer, noteName, openMic } from '../lib/scoring.ts';
import { finalMessage, MIN_SCORED_FRAMES } from '../lib/score-view.ts';
import type { ClientMessage, LyricCue, QueueItem, ReactionKind, RoomState, ServerMessage } from '../lib/types.ts';

export interface HudState {
  visible: boolean;
  score: number;
  /** A message in place of the notes (no melody, microphone denied...); empty = show "Original/You". */
  notice: string;
  original: string;
  sung: string;
}

export interface FinalResult {
  score: number;
  singer: string;
  message: string;
}

export interface TvUi {
  setRoom(state: RoomState): void;
  /** A notice in the footer; with `ms` > 0 it goes away after that long. */
  notify(text: string, ms?: number): void;
  setUnlock(show: boolean): void;
  setHud(hud: HudState): void;
  setProgress(percent: number): void;
  /** The result of the song that just ended (goes away after 9 s). */
  setFinal(result: FinalResult | null): void;
  /** A Reaction from the phones (applause, fire...) to float up the screen. */
  addReaction(kind: ReactionKind, name?: string): void;
  /** Does the melody guide have notes to draw (the Room turned it on and the song has a melody)? */
  setGuideReady(ready: boolean): void;
}

/** What drawing the melody guide needs on each frame. */
export interface GuideFrame {
  notes: MelodyNote[];
  /** The chosen key (semitones): the original's notes go up or down with it. */
  transpose: number;
  /** The position (s) of the song being heard now. */
  position: number;
  /** What the microphone picked up: the song time at which it was sung and the note (null = no pitch). */
  trail: { t: number; midi: number | null }[];
  /** The second singer's trail (a duet with two microphones). */
  trailB: { t: number; midi: number | null }[];
  /** Duet: whose part it is at instant `t` (song time): 'a', 'b', 'both' or null; without a duet, null. */
  partAt: ((t: number) => 'a' | 'b' | 'both' | null) | null;
}

type Connection = { send(message: ClientMessage): void; close(): void };

const FINAL_SECONDS = 9;

export function createTvController(code: string, ui: TvUi, lyricsEls: { prev: HTMLElement; current: HTMLElement; next: HTMLElement; next2: HTMLElement }) {
  let latest: RoomState | null = null; // the Room's latest state
  let latency = loadLatency(); // this device's sound and microphone delay (see lib/latency.ts)
  let micsChosen = loadMics(); // the microphones chosen on this TV (empty = the default); the first one also serves the scoring
  let applying = false;
  let endedFor: number | null = null; // avoids saying twice that the same song ended
  let resumed = false; // only the first song loaded after the page opens resumes from an earlier position
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;

  // scoring through the microphone (only when the Host turns it on and the song has the reference melody)
  let mic: Awaited<ReturnType<typeof openMic>> | null = null;
  let micFailed = false;
  // a duet with two microphones: the second microphone and one scorer per singer (each one counts only their own lines)
  let micB: Awaited<ReturnType<typeof openMic>> | null = null;
  let scorerB: ReturnType<typeof createScorer> | null = null;
  let scorer: ReturnType<typeof createScorer> | null = null;
  let scorerFor: number | null = null; // the item the `scorer` follows
  let hud: HudState = { visible: false, score: 0, notice: '', original: '', sung: '' };
  let shownNotes = '';

  const notify = (text: string, ms = 0) => {
    clearTimeout(noticeTimer);
    ui.notify(text);
    if (ms) noticeTimer = setTimeout(() => ui.notify(''), ms);
  };

  function setHud(patch: Partial<HudState>) {
    const next = { ...hud, ...patch };
    if ((Object.keys(next) as (keyof HudState)[]).every((key) => next[key] === hud[key])) return; // nothing changed: no redraw
    hud = next;
    ui.setHud(hud);
  }

  const engine = createEngine({
    lyricsEls,
    onEnded(itemId: number) {
      if (endedFor === itemId) return;
      endedFor = itemId;
      reportScore(itemId);
      connection.send({ type: 'ended', item_id: itemId });
    },
    // the lyrics also go to the singers' Stage (on the phone): with the songs on the Owner's computer, only the TV reaches them
    onLyrics(itemId: number, cues: LyricCue[]) {
      connection.send({ type: 'lyrics', item_id: itemId, cues });
    },
    // the squeal (feedback) appeared: the engine already cut the voice's volume; the TV shows a notice for a few seconds
    onFeedback({ hz, mic, mics }: { hz: number | null; mic?: number; mics?: number }) {
      notify(mics && mics > 1 ? t('ctl.feedbackMic', { hz: hz ?? 0, n: (mic ?? 0) + 1 }) : t('ctl.feedback', { hz: hz ?? 0 }), 10000);
    },
    onError(itemId: number, message: string) {
      // keeps the Room from getting stuck on a song that does not load: shows a notice, waits a little and moves on to the next one
      notify(t('ctl.skipping', { message }), 5000);
      setTimeout(() => {
        if (engine.loadedId !== itemId) return; // the Room already moved to another song
        engine.clear();
        connection.send({ type: 'ended', item_id: itemId });
      }, 2500);
    },
  });

  // --- scoring and the melody guide: both read the song's melody and the microphone ---
  let melodyFor: number | null = null; // the item whose melody is loaded
  let melodyData: { hop: number; midi: number[] } | null = null;
  let guideNotes: MelodyNote[] = [];
  let guidePitch = 0; // the chosen key of the current song
  let partsNow: string | null | undefined = null; // how the duet's lyrics are split in the current song (it can change in the middle of it)
  let guideOn = false; // the Room asked for the melody guide
  let trail: { t: number; midi: number | null }[] = [];
  let trailB: { t: number; midi: number | null }[] = [];
  let guideDuet = false; // the current song is an accepted duet (the bars take on the parts' colors)
  let partsMemo: { cues: unknown; chosen: string | null | undefined; parts: ('a' | 'b' | 'both' | null)[] } | null = null;

  function stopScoring() {
    mic?.stop();
    mic = null;
    micB?.stop();
    micB = null;
    scorerB = null;
    micFailed = false;
    scorer = null;
    scorerFor = null;
    melodyFor = null;
    melodyData = null;
    guideNotes = [];
    guideOn = false;
    trail = [];
    trailB = [];
    shownNotes = '';
    setHud({ visible: false });
    ui.setGuideReady(false);
  }

  async function ensureMic() {
    if (!mic && !micFailed) {
      try {
        mic = await openMic(micsChosen[0]?.id);
      } catch {
        micFailed = true;
      }
    }
    // a duet scored per voice: the second microphone is voice 2's (if it does not open, the whole song is scored by the first one)
    if (scorerB && !micB) {
      try {
        micB = await openMic(micsChosen[1]?.id);
      } catch {
        scorerB = null;
      }
    }
  }

  /** The song's scorers: just one, or one per singer in a duet with two microphones (each one counts only their own lines). */
  function makeScorers(melody: { hop: number; midi: number[] }, current: QueueItem) {
    const duet = current.guest?.status === 'accepted' && micsChosen.length >= 2;
    if (!duet) {
      scorerB = null;
      return createScorer(melody, { transpose: current.pitch });
    }
    const include = (me: 'a' | 'b') => (t: number) => {
      const cues = engine.cues;
      return singsAt(cues, splitParts(cues, partsNow), t + engine.offset, me); // the lyrics run `offset` s ahead of the melody (the lyrics adjustment)
    };
    scorerB = createScorer(melody, { transpose: current.pitch, include: include('b') });
    return createScorer(melody, { transpose: current.pitch, include: include('a') });
  }

  /** Sets up (or keeps) the scoring and the melody guide for the current song. */
  async function prepareScoring(state: RoomState, current: QueueItem | null) {
    const wantScore = Boolean(state.scoring);
    const wantGuide = Boolean(state.melody_bars);
    if (!wantScore && !wantGuide) return stopScoring();
    guideOn = wantGuide;
    setHud({ visible: wantScore && Boolean(current) });
    if (!current) return ui.setGuideReady(false);
    const melodyUrl = current.song.media?.melody;
    if (!melodyUrl) {
      shownNotes = '';
      scorer = null;
      scorerFor = null;
      melodyFor = null;
      guideNotes = [];
      ui.setGuideReady(false);
      return setHud({ notice: wantScore ? t('ctl.noMelody') : '' });
    }
    guidePitch = current.pitch;
    partsNow = current.parts;
    guideDuet = current.guest?.status === 'accepted';
    if (melodyFor === current.id) {
      scorer?.setTranspose(current.pitch);
      scorerB?.setTranspose(current.pitch);
      // the Host turned the scoring on or off in the middle of the song: the melody is already here
      if (wantScore && !scorer && melodyData) {
        scorer = makeScorers(melodyData, current);
        scorerFor = current.id;
        shownNotes = '';
        setHud({ score: 0, notice: '' });
      }
      if (!wantScore && scorer) {
        scorer = null;
        scorerB = null;
        scorerFor = null;
      }
      ui.setGuideReady(wantGuide && guideNotes.length > 0);
      return ensureMic();
    }
    melodyFor = current.id;
    melodyData = null;
    scorer = null;
    scorerB = null;
    scorerFor = null;
    guideNotes = [];
    trail = [];
    trailB = [];
    shownNotes = '';
    ui.setGuideReady(false);
    if (wantScore) setHud({ score: 0, notice: '' });
    try {
      const res = await fetch(melodyUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const melody = await res.json();
      if (melodyFor !== current.id) return; // the Room already moved to another song
      melodyData = melody;
      guideNotes = melodyNotes(melody);
      if (wantScore) {
        scorer = makeScorers(melody, current);
        scorerFor = current.id;
      }
    } catch {
      melodyFor = null;
      shownNotes = '';
      return setHud({ notice: wantScore ? t('ctl.melodyFail') : '' });
    }
    ui.setGuideReady(wantGuide && guideNotes.length > 0);
    await ensureMic();
    shownNotes = '';
    setHud({ notice: wantScore && micFailed ? t('ctl.micFail') : '' });
  }

  // ~10 readings a second: the microphone feeds the guide's trail and the scoring (the sung note against the melody at that instant)
  const scoreTimer = setInterval(() => {
    if (!mic || !engine.playing || engine.loadedId === null || engine.loadedId !== melodyFor) return;
    const { midi } = mic.read();
    const midiB = micB ? micB.read().midi : null; // the second singer (a duet with two microphones)
    const at = sungPosition(engine.currentTime, latency);
    if (guideOn) {
      trail = pushTrail(trail, { t: at, midi });
      if (micB) trailB = pushTrail(trailB, { t: at, midi: midiB });
    }
    if (!scorer || engine.loadedId !== scorerFor) return;
    let live: number | null = scorer.tick(at, midi);
    let shown = scorer; // whose notes the board shows: in a duet, whoever is singing now
    if (scorerB && micB) {
      const liveB = scorerB.tick(at, midiB);
      const cues = engine.cues;
      const parts = splitParts(cues, partsNow);
      if (singsAt(cues, parts, at + engine.offset, 'b') && !singsAt(cues, parts, at + engine.offset, 'a')) shown = scorerB;
      const values = [live, liveB].filter((value): value is number => value !== null);
      live = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null; // the board shows the pair's average
    }
    const original = noteName(shown.reference);
    const sung = noteName(shown.sung);
    const key = `${original}|${sung}`;
    if (key !== shownNotes) {
      shownNotes = key;
      setHud({ notice: '', original, sung });
    }
    setHud({ score: live ?? 0 });
  }, 100);

  /** The song's natural end: sends the score to the server (the scoreboard) and shows the result. */
  function reportScore(itemId: number) {
    if (!scorer || scorerFor !== itemId) return;
    const item = latest?.queue.find((entry) => entry.id === itemId);
    if (scorerB) {
      // a duet scored per voice: each singer has their own score (from their lines only); the song's score is the average of the ones that count
      const a = scorer.evaluated >= MIN_SCORED_FRAMES ? (scorer.score() as number) : null;
      const b = scorerB.evaluated >= MIN_SCORED_FRAMES ? (scorerB.score() as number) : null;
      const values = [a, b].filter((value): value is number => value !== null);
      if (!values.length) return;
      const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
      const names = [a !== null ? `${item?.added_by ?? ''} ${a}` : null, b !== null ? `${item?.guest?.name ?? ''} ${b}` : null].filter(Boolean);
      connection.send({ type: 'score', item_id: itemId, score: average });
      ui.setFinal({ score: average, singer: names.join(' · '), message: finalMessage(average) });
      clearTimeout(finalTimer);
      finalTimer = setTimeout(() => ui.setFinal(null), FINAL_SECONDS * 1000);
      return;
    }
    if (scorer.evaluated < MIN_SCORED_FRAMES) return;
    const score = scorer.score() as number;
    const singer = item?.singers ?? '';
    // debugging: uncomment to see the final score and the table with every block
    // console.log(`[scoring] end of the song: ${score} points`);
    // console.table(scorer.report());
    connection.send({ type: 'score', item_id: itemId, score });
    ui.setFinal({ score, singer, message: finalMessage(score) });
    clearTimeout(finalTimer);
    finalTimer = setTimeout(() => ui.setFinal(null), FINAL_SECONDS * 1000);
  }

  // --- the voice from the TV's microphone in the speakers (the Host turns it on) ---
  let voiceOn = false;
  let voiceFailed = false;
  let voiceBusy = false;
  let voiceKey = ''; // which microphones are open on the output

  /** Keeps the voice in line with the Room: turns the microphone on or off and sets the volume (muted while nothing plays). */
  async function syncVoice() {
    const state = latest;
    if (!state?.voice) {
      if (voiceOn || voiceFailed) {
        engine.detachVoice();
        voiceOn = false;
        voiceFailed = false;
      }
      return;
    }
    if (voiceOn && voiceKey !== micsKey(micsChosen)) {
      // the choice of microphones changed: releases the current ones and opens the new ones
      engine.detachVoice();
      voiceOn = false;
      voiceFailed = false;
    }
    if (!voiceOn && !voiceFailed && !voiceBusy) {
      voiceBusy = true;
      try {
        const ids = micsChosen.length ? micsChosen.map((mic) => mic.id) : ['']; // no choice: the default microphone, as always
        const streams: MediaStream[] = [];
        for (const id of ids) {
          try {
            streams.push(await openVoice(id));
          } catch {
            // this microphone did not open (disconnected, no permission): the others carry on
          }
        }
        if (!streams.length) throw new Error('no microphone');
        await engine.attachVoice(streams);
        voiceKey = micsKey(micsChosen);
        voiceOn = true;
        if (streams.length < ids.length) notify(t('ctl.someMicsFail', { open: streams.length, total: ids.length }), 8000);
      } catch {
        voiceFailed = true;
        notify(t('ctl.voiceMicFail'), 8000);
      } finally {
        voiceBusy = false;
      }
    }
    if (voiceOn) engine.setVoiceGain(voiceGain(state.voice_volume, { playing: engine.playing }));
  }
  const voiceTimer = setInterval(() => void syncVoice(), 400);

  // --- Room ---
  const connection: Connection = connectRoom(code, 'tv', {
    onMessage(message: ServerMessage) {
      if (message.type === 'seek') {
        if (message.item_id !== engine.loadedId) return;
        // with no duration yet (the audio has just started loading), there is no limit to the jump forward
        const limit = engine.duration ? engine.duration - 0.5 : Infinity;
        const target = message.to ?? engine.currentTime + (message.seconds ?? 0); // a target point or a relative jump
        engine.seek(Math.min(Math.max(target, 0), limit));
        connection.send({ type: 'position', item_id: engine.loadedId, ms: Math.round(engine.heardTime * 1000) });
        return;
      }
      if (message.type === 'reaction') {
        ui.addReaction(message.kind, message.name);
        return;
      }
      if (message.type !== 'state') return;
      latest = message.state;
      ui.setRoom(latest);
      void syncVoice();
      void apply();
    },
    onStatus(status: string) {
      notify(status === 'reconnecting' ? t('ctl.reconnecting') : '');
    },
    onGone() {
      notify(t('ctl.gone'));
    },
  });

  async function startPlayback() {
    try {
      await engine.play();
      ui.setUnlock(false);
    } catch {
      ui.setUnlock(true); // the browser requires a click before playing audio
    }
  }

  async function syncPlayback(playback: string) {
    if (playback === 'playing') {
      if (!engine.playing) await startPlayback();
    } else if (playback === 'paused') {
      engine.pause();
    }
  }

  /** Applies the Room's latest state; if another one arrives while loading, repeats until it catches up. */
  async function apply() {
    if (applying) return;
    applying = true;
    try {
      let state: RoomState | null;
      do {
        state = latest;
        if (!state) break;
        const { current }: { current: QueueItem | null } = splitQueue(state);
        void prepareScoring(state, current);
        if (!current) {
          engine.clear();
          endedFor = null;
        } else {
          if (engine.loadedId !== current.id) {
            endedFor = null;
            await engine.load(current);
            // the TV reloaded in the middle of a song: resumes from where the server knows it was (the position is reported every 2 s)
            if (!resumed && state.position_ms > 2000) engine.seek(state.position_ms / 1000);
            resumed = true;
          } else {
            engine.setPitch(current.pitch);
            engine.setBacking(current.backing);
            engine.setGuide(current.guide);
            engine.setOffset(current.lyric_offset);
            engine.setDuet(current.guest?.status === 'accepted', current.parts);
          }
          await syncPlayback(state.playback);
          if (engine.playing && current.pitch !== 0 && !engine.pitchAvailable) {
            notify(t('ctl.pitchFail'));
          }
        }
      } while (state !== latest);
    } finally {
      applying = false;
    }
  }

  // the song's progress bar
  const progressTimer = setInterval(() => {
    const duration = engine.duration;
    ui.setProgress(engine.loadedId !== null && duration ? Math.min(100, (engine.currentTime / duration) * 100) : 0);
  }, 250);

  // the song's position for the phones (the progress bar and the Stage's lyrics, which run on their own between one message and the next)
  const positionTimer = setInterval(() => {
    if (engine.playing && engine.loadedId !== null) {
      connection.send({ type: 'position', item_id: engine.loadedId, ms: Math.round(engine.heardTime * 1000) });
    }
  }, 1000);

  engine.setOutputLatency(latency.output);
  engine.setVoiceFilter(loadVoiceFilter());

  return {
    engine,
    get mics() {
      return micsChosen;
    },
    /** The melody guide's board: the notes, the key, the position being heard and what was sung a moment ago. */
    guideFrame(): GuideFrame {
      let partAt: GuideFrame['partAt'] = null;
      if (guideDuet) {
        const cues = engine.cues;
        if (!partsMemo || partsMemo.cues !== cues || partsMemo.chosen !== partsNow) partsMemo = { cues, chosen: partsNow, parts: splitParts(cues, partsNow) };
        const { parts } = partsMemo;
        partAt = (t: number) => partAtTime(cues, parts, t + engine.offset); // the lyrics run `offset` s ahead of the melody
      }
      return { notes: guideNotes, transpose: guidePitch, position: engine.heardTime, trail, trailB, partAt };
    },
    get voiceFilter() {
      return engine.voiceFilter;
    },
    /** Reduce the voice's noise and echo (a low-cut filter and a noise gate): kept on this TV. */
    setVoiceFilter(on: boolean) {
      engine.setVoiceFilter(saveVoiceFilter(on));
      return engine.voiceFilter;
    },
    /** Chooses the output's microphones (and the scoring's, the first one); the voice reopens on its own with the new choice. */
    setMics(next: { id: string; label: string }[]) {
      micsChosen = saveMics(next);
      stopScoring(); // the scoring reopens the microphone with the first one on the list
      void apply();
      void syncVoice();
      return micsChosen;
    },
    get latency() {
      return latency;
    },
    /** Saves and applies the output's delay (lyrics) and the input's (scoring), in ms. */
    setLatency(next: { output: number; input: number }) {
      latency = saveLatency({ output: clampLatency(next.output), input: clampLatency(next.input) });
      engine.setOutputLatency(latency.output);
      return latency;
    },
    get state() {
      return latest;
    },
    /** A click on "turn on the sound": the browser only allows audio after a gesture. */
    async unlock() {
      await engine.unlock();
      await startPlayback();
    },
    stop() {
      clearInterval(scoreTimer);
      clearInterval(progressTimer);
      clearInterval(positionTimer);
      clearInterval(voiceTimer);
      engine.detachVoice();
      clearTimeout(noticeTimer);
      clearTimeout(finalTimer);
      stopScoring();
      engine.clear();
      connection.close();
    },
  };
}

export type TvController = ReturnType<typeof createTvController>;
