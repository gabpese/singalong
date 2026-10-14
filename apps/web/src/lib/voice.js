// A voz de quem canta (microfones da TV) na saída de áudio, junto com a música. O anfitrião liga e escolhe o volume; a TV escolhe
// quais microfones entram (um ou vários: um cantor por microfone).

/** 50 % = a voz entra como o microfone a capta (ganho 1); 100 % = o dobro; 0 = mudo. */
export const VOICE_UNITY = 50;

/** Quantos microfones podem entrar na saída ao mesmo tempo. */
export const MAX_MICS = 4;

/** Volume escolhido (0..100) → ganho do Web Audio. Só soa com a opção ligada e a música tocando (microfone aberto parado só dá microfonia). */
export function voiceGain(level, { enabled = true, playing = true } = {}) {
  if (!enabled || !playing) return 0;
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100) / VOICE_UNITY;
}

/**
 * Abre um microfone para a saída de áudio. Cancelamento de eco ligado (o instrumental que sai das caixas não volta como voz),
 * supressão de ruído ligada e sem ganho automático (ele sobe o volume sozinho e provoca o apito da microfonia).
 * `deviceId` escolhe o aparelho; "ideal" (e não "exact") para cair no padrão se o escolhido foi desconectado.
 */
export function openVoice(deviceId = '', getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints)) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1, latency: 0 };
  if (deviceId) audio.deviceId = { ideal: deviceId };
  return getUserMedia({ audio });
}

const KEY = 'voiceMics';

/** Os microfones escolhidos nesta TV: [{ id, label }], no máximo MAX_MICS. Vazio = o microfone padrão (como sempre foi). */
export function loadMics() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return cleanMics(saved);
  } catch {
    return []; // sem armazenamento (ou fora do navegador)
  }
}

export function saveMics(mics) {
  const clean = cleanMics(mics);
  try {
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // sem armazenamento: vale só até recarregar
  }
  return clean;
}

/** Só { id, label } com id de texto, sem repetidos, até MAX_MICS. */
export function cleanMics(mics) {
  if (!Array.isArray(mics)) return [];
  const seen = new Set();
  const result = [];
  for (const mic of mics) {
    const id = typeof mic?.id === 'string' ? mic.id.slice(0, 300) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: String(mic.label ?? '').slice(0, 120) });
    if (result.length === MAX_MICS) break;
  }
  return result;
}

/** Uma chave que muda quando a escolha muda (para saber se é preciso reabrir os microfones). */
export const micsKey = (mics) => cleanMics(mics).map((mic) => mic.id).join('|');

/** Os microfones do aparelho, com nome (a permissão é pedida e solta na hora, só para o navegador mostrar os nomes). */
export async function listMicrophones(mediaDevices = navigator.mediaDevices) {
  try {
    const probe = await mediaDevices.getUserMedia({ audio: true });
    for (const track of probe.getTracks()) track.stop();
  } catch {
    // sem permissão: a lista pode vir sem nomes
  }
  const devices = (await mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return devices.map((d, i) => ({ id: d.deviceId, label: d.label || `Microfone ${i + 1}` }));
}
