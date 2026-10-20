// Stage rules (the phone's singing screen): when the singer is taken there and when they go back to the Room.

import type { RoomState } from './types.ts';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const key = (code: string, itemId: number) => `stage-dismissed:${code}:${itemId}`;

/** The singer left the Stage on their own during this song: the Room does not take them back. */
export function dismissStage(code: string, itemId: number, storage: Store | undefined = globalThis.sessionStorage): void {
  try {
    storage?.setItem(key(code, itemId), '1');
  } catch {
    /* no storage: it only lasts until a reload */
  }
}

export function stageDismissed(code: string, itemId: number, storage: Store | undefined = globalThis.sessionStorage): boolean {
  try {
    return storage?.getItem(key(code, itemId)) === '1';
  } catch {
    return false;
  }
}

/**
 * Is the item playing now mine (or am I singing along, in a Duet)? Then it is my turn on the Stage: returns its id, or null.
 * Only with the TV connected (the TV is what plays the song) and if I did not leave the Stage during this song.
 */
export function stageItemFor(
  state: Pick<RoomState, 'playback' | 'tv_connected' | 'queue' | 'current_item_id'> | null | undefined,
  dismissed: (itemId: number) => boolean = () => false,
): number | null {
  if (!state || state.playback === 'idle' || !state.tv_connected) return null;
  const current = state.queue.find((item) => item.id === state.current_item_id);
  return current && (current.mine || current.guest_me) && !dismissed(current.id) ? current.id : null;
}

export const STAGE_END_SECONDS = 4; // after the song ends, the Stage shows the ending for a moment and sends the singer back to the Room
