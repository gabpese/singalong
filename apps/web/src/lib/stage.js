// Regras do palco (a tela de canto do celular): quando o cantor é levado para lá e quando volta para a sala.

const key = (code, itemId) => `stage-dismissed:${code}:${itemId}`;

/** O cantor saiu do palco por conta própria nesta música: a sala não o leva de volta. */
export function dismissStage(code, itemId, storage = globalThis.sessionStorage) {
  try {
    storage?.setItem(key(code, itemId), '1');
  } catch {
    /* sem armazenamento: só vale até recarregar */
  }
}

export function stageDismissed(code, itemId, storage = globalThis.sessionStorage) {
  try {
    return storage?.getItem(key(code, itemId)) === '1';
  } catch {
    return false;
  }
}

/**
 * O item que está tocando agora é meu (ou eu vou cantar junto, no dueto)? Então é a minha vez de ir para o palco: devolve o id dele, ou null.
 * Só vale com a TV conectada (é ela que toca a música) e se eu não saí do palco nesta música.
 */
export function stageItemFor(state, dismissed = (/** @type {number} */ _itemId) => false) {
  if (!state || state.playback === 'idle' || !state.tv_connected) return null;
  const current = state.queue.find((item) => item.id === state.current_item_id);
  return (current?.mine || current?.guest_me) && !dismissed(current.id) ? current.id : null;
}

export const STAGE_END_SECONDS = 4; // depois que a música acaba, o palco mostra o fim por um instante e devolve o cantor à sala
