// The window's video card choices (settings and the first Session): NVIDIA and AMD, which are automatic when the card can run an
// engine, and Apple's GPU (Metal), which exists as an option but is in beta and never chosen by itself. Pure functions: the
// hardware comes from the worker (`--hardware`).
import type { Gpu, HardwareInfo } from './bridge.ts';

export const ACCELERATED = ['cu121', 'rocm6.2', 'mps'];
export const isAccelerated = (kind: string | null | undefined) => ACCELERATED.includes(kind ?? '');

/** The engine in use as one of the list's choices: an engine with a GPU, or "cpu". */
export const kindOf = (engineKind: string | null | undefined) => (isAccelerated(engineKind) ? engineKind! : 'cpu');

/** What to show of a card: its name and, when there is one, the driver (Apple and AMD have no driver number that helps). */
export const gpuName = (gpu: Gpu) => (gpu.vendor === 'nvidia' || !gpu.vendor ? `${gpu.name} (driver ${gpu.driver})` : gpu.name);

/** The card that becomes an option: the recommended engine's; NVIDIA and Apple always (the person chooses); AMD only when ROCm takes it. */
export function offeredGpu(info: HardwareInfo | null | undefined): Gpu | null {
  const gpus = (info?.gpus ?? []).filter((gpu) => gpu.engine ?? 'cu121');
  return gpus.find((gpu) => (gpu.engine ?? 'cu121') === info!.engine) ?? gpus.find((gpu) => gpu.vendor === 'nvidia' || !gpu.vendor || gpu.vendor === 'apple') ?? null;
}

/** { gpu, options: [[value, label]], current, wanted }: `wanted` is the option that matches the engine in use. */
export function gpuChoices(info: HardwareInfo | null | undefined, engineKind: string | null | undefined) {
  const gpu = offeredGpu(info);
  const options: [string, string][] = [['auto', info ? `Automático (recomendado: ${isAccelerated(info.engine) ? 'placa de vídeo' : 'processador'})` : 'Automático']];
  if (gpu) {
    const kind = gpu.engine ?? 'cu121';
    options.push([kind, kind === 'mps' ? `GPU da Apple (beta): ${gpu.name}` : `Placa de vídeo: ${gpu.name}`]);
  }
  options.push(['cpu', 'Processador (mais lento)']);
  const current = kindOf(engineKind);
  const wanted = options.some(([value]) => value === current) ? current : 'auto';
  return { gpu, options, current, wanted };
}

/** "In use: …": the installed engine, for the settings. */
export function engineInUse(engineKind: string | null | undefined): string {
  return engineKind === 'mps' ? 'GPU da Apple (beta)' : isAccelerated(engineKind) ? 'placa de vídeo' : 'processador';
}

/** The computer's line: its cores, memory and card (or the lack of one that works). */
export function machineLine(info: HardwareInfo | null | undefined, gpu: Gpu | null): string {
  if (!info) return '';
  const memory = info.ram_mb ? Math.round(info.ram_mb / 1024) : '?';
  return `${info.cpu_cores} núcleos · ${memory} GB de memória · ${gpu ? gpuName(gpu) : 'sem placa de vídeo compatível'}`;
}
