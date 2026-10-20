// The singer's voice (the TV's microphones) on the audio output, together with the music. The Host turns it on and picks the
// volume; the TV picks which microphones come in (one or several: one singer per microphone).

/** 50 % = the voice comes in as the microphone picks it up (gain 1); 100 % = double; 0 = muted. */
export const VOICE_UNITY = 50;

/** How many microphones can go to the output at once. */
export const MAX_MICS = 4;

export interface Mic {
  id: string;
  label: string;
}

/** The chosen volume (0..100) → Web Audio gain. Only sounds with the option on and the song playing (an open mic at rest only feeds back). */
export function voiceGain(level: unknown, { enabled = true, playing = true }: { enabled?: boolean; playing?: boolean } = {}): number {
  if (!enabled || !playing) return 0;
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100) / VOICE_UNITY;
}

/**
 * Opens a microphone for the audio output. Echo cancellation on (the instrumental coming out of the speakers does not come back
 * as voice), noise suppression on and no automatic gain (it raises the volume by itself and causes the feedback whistle).
 * `deviceId` picks the device; "ideal" (not "exact") to fall back to the default if the chosen one was unplugged.
 */
export function openVoice(
  deviceId = '',
  getUserMedia = (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints),
): Promise<MediaStream> {
  const audio: MediaTrackConstraints & { latency?: number } = { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1, latency: 0 };
  if (deviceId) audio.deviceId = { ideal: deviceId };
  return getUserMedia({ audio });
}

const KEY = 'voiceMics';
const FILTER_KEY = 'voiceFilter';

/** Reduce the voice's noise and echo (high-pass filter and noise gate)? On by default; the choice stays on this TV. */
export function loadVoiceFilter(): boolean {
  try {
    return localStorage.getItem(FILTER_KEY) !== 'off';
  } catch {
    return true; // no storage (or outside a browser)
  }
}

export function saveVoiceFilter(on: boolean): boolean {
  try {
    localStorage.setItem(FILTER_KEY, on ? 'on' : 'off');
  } catch {
    // no storage: it only lasts until a reload
  }
  return Boolean(on);
}

/** The microphones chosen on this TV, at most MAX_MICS. Empty = the default microphone (as it always was). */
export function loadMics(): Mic[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return cleanMics(saved);
  } catch {
    return []; // no storage (or outside a browser)
  }
}

export function saveMics(mics: unknown): Mic[] {
  const clean = cleanMics(mics);
  try {
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // no storage: it only lasts until a reload
  }
  return clean;
}

/** Only { id, label } with a text id, without repeats, up to MAX_MICS. */
export function cleanMics(mics: unknown): Mic[] {
  if (!Array.isArray(mics)) return [];
  const seen = new Set<string>();
  const result: Mic[] = [];
  for (const mic of mics as ({ id?: unknown; label?: unknown } | null | undefined)[]) {
    const id = typeof mic?.id === 'string' ? mic.id.slice(0, 300) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: String(mic?.label ?? '').slice(0, 120) });
    if (result.length === MAX_MICS) break;
  }
  return result;
}

/** A key that changes when the choice changes (to know whether the microphones must be reopened). */
export const micsKey = (mics: unknown): string => cleanMics(mics).map((mic) => mic.id).join('|');

/** The device's microphones, with names (the permission is asked and released at once, only so the browser shows the names). */
export async function listMicrophones(mediaDevices: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> = navigator.mediaDevices): Promise<Mic[]> {
  try {
    const probe = await mediaDevices.getUserMedia({ audio: true });
    for (const track of probe.getTracks()) track.stop();
  } catch {
    // no permission: the list may come without names
  }
  const devices = (await mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return devices.map((d, i) => ({ id: d.deviceId, label: d.label || `Microfone ${i + 1}` }));
}
