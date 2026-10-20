// Types for the vendored SoundTouch AudioWorklet node: the source next to this file is plain JavaScript.

export interface SoundTouchNodeOptions {
  context: BaseAudioContext;
  sampleBufferType?: string;
  interpolationStrategy?: string;
  outputChannelCount?: number;
}

export declare class SoundTouchNode extends AudioWorkletNode {
  static processorName: string;
  /** Loads the processor script into the AudioWorklet; call it before creating a node. */
  static register(context: BaseAudioContext, processorUrl: string): Promise<void>;
  static registerStrategyModule(context: BaseAudioContext, strategyModuleUrl: string): Promise<void>;
  constructor(options: SoundTouchNodeOptions);
  readonly metrics: { framesBuffered: number; underrunCount: number; blockCount: number } | null;
  /** Pitch multiplier (1.0 = original pitch). */
  readonly pitch: AudioParam;
  /** Pitch shift in semitones. */
  readonly pitchSemitones: AudioParam;
  readonly playbackRate: AudioParam;
  setInterpolationStrategy(strategy: string): void;
}
