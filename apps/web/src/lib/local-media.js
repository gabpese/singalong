// Músicas no computador do dono (armazenamento local): a TV as busca de um servidor local de mídia, e o Chrome/Edge pedem ao
// usuário a permissão de "Acesso à rede local" na primeira vez. Estas funções puras decidem o que a TV mostra (TRD, seção 5).

/**
 * O endereço do servidor local de mídia ("http://127.0.0.1:8765/token"), tirado do endereço de uma música local da fila;
 * null se a sala não tem música local.
 * @param {{ queue?: Array<{ song?: { media?: { local?: boolean, instrumental?: string } | null } }> } | null | undefined} state
 */
export function localMediaBase(state) {
  const url = state?.queue?.map((item) => item.song?.media).find((media) => media?.local)?.instrumental;
  const match = url ? /^(.*)\/cache\//.exec(url) : null;
  return match ? match[1] : null;
}

/** Quanto tempo esperar a resposta antes de dar o acesso por bloqueado (o usuário pode estar lendo o aviso do navegador). */
export const PROBE_TIMEOUT_MS = 30_000;
/** Depois de quanto tempo pendente a TV passa a explicar o aviso do navegador. */
export const HINT_AFTER_MS = 1_500;

/**
 * O texto que a TV mostra sobre o acesso ao servidor local de mídia.
 * @param {'idle' | 'checking' | 'ok' | 'blocked'} status
 * @param {number} elapsedMs há quanto tempo a verificação está pendente
 */
export function accessMessage(status, elapsedMs = 0) {
  if (status === 'checking' && elapsedMs >= HINT_AFTER_MS) {
    return 'Se o navegador perguntar, escolha Permitir: as músicas desta sala estão no computador do dono e precisam do acesso à rede local.';
  }
  if (status === 'blocked') {
    return 'O navegador bloqueou o acesso às músicas deste computador. Clique no cadeado ao lado do endereço, abra as configurações do site, permita o acesso à rede local e recarregue a página.';
  }
  return '';
}

/**
 * Verifica se a página consegue falar com o servidor local de mídia (isto também provoca o aviso de permissão do navegador).
 * @param {string} base
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function probeLocalMedia(base, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/ping`, { cache: 'no-store', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
