import assert from 'node:assert/strict';
import test from 'node:test';
import { openVoice, VOICE_UNITY, voiceGain } from '../src/lib/voice.js';

test('o volume vira ganho: 50% é o ganho 1, 100% o dobro, 0 é mudo', () => {
  assert.equal(VOICE_UNITY, 50);
  assert.equal(voiceGain(50), 1);
  assert.equal(voiceGain(100), 2);
  assert.equal(voiceGain(0), 0);
  assert.equal(voiceGain(40), 0.8); // o padrão da sala: baixo
});

test('só soa com a opção ligada e a música tocando (microfone aberto parado só dá microfonia)', () => {
  assert.equal(voiceGain(80, { playing: false }), 0);
  assert.equal(voiceGain(80, { enabled: false }), 0);
  assert.equal(voiceGain(80, { enabled: true, playing: true }), 1.6);
});

test('valores fora da faixa ou inválidos não passam de 2x nem quebram', () => {
  assert.equal(voiceGain(500), 2);
  assert.equal(voiceGain(-20), 0);
  assert.equal(voiceGain('lixo'), 0);
  assert.equal(voiceGain(undefined), 0);
  assert.equal(voiceGain(33.4), 0.66);
});

test('abre o microfone com cancelamento de eco e supressão de ruído e sem ganho automático', async () => {
  let asked;
  const stream = await openVoice(async (constraints) => {
    asked = constraints;
    return { id: 'fluxo' };
  });
  assert.deepEqual(stream, { id: 'fluxo' });
  assert.equal(asked.audio.echoCancellation, true);
  assert.equal(asked.audio.noiseSuppression, true);
  assert.equal(asked.audio.autoGainControl, false); // o ganho automático sobe sozinho e provoca o apito
  assert.equal(asked.video, undefined);
});
