// What the pages expose to the tests (the TV's engine and state), and what the tests themselves leave on `window` inside a page.
import type { createEngine } from '../src/lib/engine.ts';
import type { RoomState } from '../src/lib/types.ts';

declare global {
  interface Window {
    tv: { engine: ReturnType<typeof createEngine>; readonly state: RoomState | null };
    /** backing.spec.ts: an analyser that listens to the TV's output. */
    __analyser?: AnalyserNode;
    __rms: () => number;
    /** tv.spec.ts: the phones and Bia's socket that the test opens. */
    phones: WebSocket[];
    bia: WebSocket;
  }
}
