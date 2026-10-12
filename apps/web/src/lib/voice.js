// A voz de quem canta (microfone da TV) na saída de áudio, junto com a música. O anfitrião liga e escolhe o volume.

/** 50 % = a voz entra como o microfone a capta (ganho 1); 100 % = o dobro; 0 = mudo. */
export const VOICE_UNITY = 50;

/** Volume escolhido (0..100) → ganho do Web Audio. Só soa com a opção ligada e a música tocando (microfone aberto parado só dá microfonia). */
export function voiceGain(level, { enabled = true, playing = true } = {}) {
  if (!enabled || !playing) return 0;
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100) / VOICE_UNITY;
}

/**
 * Abre o microfone para a saída de áudio. Cancelamento de eco ligado (o instrumental que sai das caixas não volta como voz),
 * supressão de ruído ligada e sem ganho automático (ele sobe o volume sozinho e provoca o apito da microfonia).
 */
export function openVoice(getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints)) {
  return getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1, latency: 0 } });
}
