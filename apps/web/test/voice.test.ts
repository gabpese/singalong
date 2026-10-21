import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanMics, listMicrophones, MAX_MICS, micsKey, openVoice, VOICE_UNITY, voiceGain } from '../src/lib/voice.ts';

type Ask = Parameters<typeof openVoice>[1];
type Devices = Parameters<typeof listMicrophones>[0];

/** A stand-in for getUserMedia that records what it was asked for. */
function recorder() {
  const asked: MediaStreamConstraints[] = [];
  const ask = (async (constraints: MediaStreamConstraints) => {
    asked.push(constraints);
    return { id: 'stream' };
  }) as unknown as Ask;
  const audio = () => asked.at(-1)?.audio as MediaTrackConstraints;
  return { asked, ask, audio };
}

test('the volume becomes a gain: 50% is a gain of 1, 100% double, 0 mute', () => {
  assert.equal(VOICE_UNITY, 50);
  assert.equal(voiceGain(50), 1);
  assert.equal(voiceGain(100), 2);
  assert.equal(voiceGain(0), 0);
  assert.equal(voiceGain(40), 0.8); // the Room's default: low
});

test('it sounds only with the option on and the song playing (an open microphone standing still only howls)', () => {
  assert.equal(voiceGain(80, { playing: false }), 0);
  assert.equal(voiceGain(80, { enabled: false }), 0);
  assert.equal(voiceGain(80, { enabled: true, playing: true }), 1.6);
});

test('values out of range or invalid never pass 2x nor break', () => {
  assert.equal(voiceGain(500), 2);
  assert.equal(voiceGain(-20), 0);
  assert.equal(voiceGain('junk'), 0);
  assert.equal(voiceGain(undefined), 0);
  assert.equal(voiceGain(33.4), 0.66);
});

test('opens the microphone with echo cancellation and noise suppression, and without automatic gain', async () => {
  const { asked, ask, audio } = recorder();
  const stream = await openVoice('', ask);
  assert.deepEqual(stream, { id: 'stream' });
  assert.equal(audio().echoCancellation, true);
  assert.equal(audio().noiseSuppression, true);
  assert.equal(audio().autoGainControl, false); // automatic gain rises by itself and causes the howl
  assert.equal(asked[0].video, undefined);
});

test('a chosen microphone goes in as "ideal" (it falls back to the default if it was unplugged); without a choice, no deviceId', async () => {
  const { ask, audio } = recorder();
  await openVoice('mic-b', ask);
  assert.deepEqual(audio().deviceId, { ideal: 'mic-b' });
  await openVoice('', ask);
  assert.equal('deviceId' in audio(), false);
});

test('cleanMics: only text ids, no repeats, up to the maximum', () => {
  assert.deepEqual(cleanMics([{ id: 'a', label: 'A' }, { id: 'a', label: 'repeated' }, { id: '' }, null, { id: 7 }, { id: 'b' }]), [
    { id: 'a', label: 'A' },
    { id: 'b', label: '' },
  ]);
  assert.equal(cleanMics(Array.from({ length: 9 }, (_, i) => ({ id: `m${i}` }))).length, MAX_MICS);
  assert.deepEqual(cleanMics('junk'), []);
  assert.equal(micsKey([{ id: 'a', label: '' }, { id: 'b', label: '' }]), 'a|b');
  assert.equal(micsKey([]), '');
});

test('listMicrophones: only real audio inputs (no default/communications), with a name', async () => {
  const stopped: number[] = [];
  const devices = await listMicrophones({
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(1) }] }),
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications' },
      { kind: 'audioinput', deviceId: 'x1', label: 'Mic X' },
      { kind: 'audioinput', deviceId: 'x2', label: '' },
      { kind: 'audiooutput', deviceId: 'o1', label: 'Speaker' },
    ],
  } as unknown as Devices);
  assert.deepEqual(devices, [{ id: 'x1', label: 'Mic X' }, { id: 'x2', label: 'Microfone 2' }]);
  assert.equal(stopped.length, 1); // the permission is let go at once
});
