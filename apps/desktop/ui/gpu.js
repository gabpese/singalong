// As opções de placa de vídeo da janela (configurações e primeira sessão): NVIDIA e AMD, que são automáticas quando a placa serve, e a GPU da
// Apple (Metal), que existe como opção mas está em beta e nunca é escolhida sozinha. Funções puras: o hardware vem do worker (`--hardware`).

export const ACCELERATED = ['cu121', 'rocm6.2', 'mps'];
export const isAccelerated = (kind) => ACCELERATED.includes(kind);

/** O motor em uso como uma das escolhas da lista: um motor com GPU, ou "cpu". */
export const kindOf = (engineKind) => (isAccelerated(engineKind) ? engineKind : 'cpu');

/** O que mostrar de uma placa: nome e, quando existe, o driver (a Apple e a AMD não têm um número de driver que ajude). */
export const gpuName = (gpu) => (gpu.vendor === 'nvidia' || !gpu.vendor ? `${gpu.name} (driver ${gpu.driver})` : gpu.name);

/** A placa que vira opção: a do motor recomendado; a NVIDIA e a Apple sempre (a escolha é da pessoa); a AMD só se o ROCm a aceita. */
export function offeredGpu(info) {
  const gpus = (info?.gpus ?? []).filter((gpu) => gpu.engine ?? 'cu121');
  return gpus.find((gpu) => (gpu.engine ?? 'cu121') === info.engine) ?? gpus.find((gpu) => gpu.vendor === 'nvidia' || !gpu.vendor || gpu.vendor === 'apple') ?? null;
}

/** { gpu, options: [[valor, rótulo]], wanted } — `wanted` é a opção que corresponde ao motor em uso. */
export function gpuChoices(info, engineKind) {
  const gpu = offeredGpu(info);
  const options = [['auto', info ? `Automático (recomendado: ${isAccelerated(info.engine) ? 'placa de vídeo' : 'processador'})` : 'Automático']];
  if (gpu) {
    const kind = gpu.engine ?? 'cu121';
    options.push([kind, kind === 'mps' ? `GPU da Apple (beta): ${gpu.name}` : `Placa de vídeo: ${gpu.name}`]);
  }
  options.push(['cpu', 'Processador (mais lento)']);
  const current = kindOf(engineKind);
  const wanted = options.some(([value]) => value === current) ? current : 'auto';
  return { gpu, options, current, wanted };
}

/** "Em uso: …": o motor instalado, para as configurações. */
export function engineInUse(engineKind) {
  return engineKind === 'mps' ? 'GPU da Apple (beta)' : isAccelerated(engineKind) ? 'placa de vídeo' : 'processador';
}

/** A linha do computador: núcleos, memória e a placa (ou a falta de uma que sirva). */
export function machineLine(info, gpu) {
  if (!info) return '';
  const memory = info.ram_mb ? Math.round(info.ram_mb / 1024) : '?';
  return `${info.cpu_cores} núcleos · ${memory} GB de memória · ${gpu ? gpuName(gpu) : 'sem placa de vídeo compatível'}`;
}
