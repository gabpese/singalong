import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanMics, listMicrophones, MAX_MICS, micsKey, openVoice, VOICE_UNITY, voiceGain } from '../src/lib/voice.ts';

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
  const stream = await openVoice('', async (constraints) => {
    asked = constraints;
    return { id: 'fluxo' };
  });
  assert.deepEqual(stream, { id: 'fluxo' });
  assert.equal(asked.audio.echoCancellation, true);
  assert.equal(asked.audio.noiseSuppression, true);
  assert.equal(asked.audio.autoGainControl, false); // o ganho automático sobe sozinho e provoca o apito
  assert.equal(asked.video, undefined);
});

test('um microfone escolhido entra como "ideal" (cai no padrão se foi desconectado); sem escolha, nenhum deviceId', async () => {
  let asked;
  const ask = async (constraints) => {
    asked = constraints;
    return {};
  };
  await openVoice('mic-b', ask);
  assert.deepEqual(asked.audio.deviceId, { ideal: 'mic-b' });
  await openVoice('', ask);
  assert.equal('deviceId' in asked.audio, false);
});

test('cleanMics: só id de texto, sem repetidos, até o máximo', () => {
  assert.deepEqual(cleanMics([{ id: 'a', label: 'A' }, { id: 'a', label: 'repetido' }, { id: '' }, null, { id: 7 }, { id: 'b' }]), [
    { id: 'a', label: 'A' },
    { id: 'b', label: '' },
  ]);
  assert.equal(cleanMics(Array.from({ length: 9 }, (_, i) => ({ id: `m${i}` }))).length, MAX_MICS);
  assert.deepEqual(cleanMics('lixo'), []);
  assert.equal(micsKey([{ id: 'a' }, { id: 'b' }]), 'a|b');
  assert.equal(micsKey([]), '');
});

test('listMicrophones: só entradas de áudio de verdade (sem default/communications) e com nome', async () => {
  const stopped = [];
  const devices = await listMicrophones({
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(1) }] }),
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Padrão' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Comunicação' },
      { kind: 'audioinput', deviceId: 'x1', label: 'Mic X' },
      { kind: 'audioinput', deviceId: 'x2', label: '' },
      { kind: 'audiooutput', deviceId: 'o1', label: 'Caixa' },
    ],
  });
  assert.deepEqual(devices, [{ id: 'x1', label: 'Mic X' }, { id: 'x2', label: 'Microfone 2' }]);
  assert.equal(stopped.length, 1); // a permissão é solta na hora
});
