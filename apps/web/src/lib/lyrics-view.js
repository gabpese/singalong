// Desenho da letra sincronizada (anterior, atual com palavras preenchidas, próximas e o aviso de pausa longa). Não sabe de onde vem
// o relógio: a TV passa o tempo do áudio; o palco do celular, o de um relógio sincronizado com a TV.
import { splitParts } from './duet.js';
import { gapDisplay, lineProgress, locate, wordFills, wordProgress, wordSpans } from './lyrics-sync.js';

/** Põe (ou tira) o dono da linha: sem dono o atributo SOME (vazio ainda casaria com o CSS do dueto). */
function mark(el, part) {
  if (part) el.dataset.part = part;
  else el.removeAttribute('data-part');
}

/** @param els elementos { prev, current, next, next2 } onde a letra é desenhada */
export function createLyricsView(els) {
  let cues = [];
  let duet = false; // dueto: cada linha tem um dono (a, b ou os dois) e ganha a cor dele
  let parts = [];
  let offset = 0;
  let lastKey = '';
  let words = []; // [{el, span, p}] da linha atual
  let gapEl = null; // o aviso de pausa longa, quando está na tela
  let lastDashes = -1;

  function clear() {
    for (const el of [els.prev, els.current, els.next, els.next2]) el.textContent = '';
    words = [];
    lastKey = '';
  }

  /** Monta a linha atual com um <span> por palavra (cada um com seu preenchimento: a quebra de linha não importa). */
  function buildCurrentLine(text) {
    els.current.textContent = '';
    words = wordSpans(text).map((span, i) => {
      const el = document.createElement('span');
      el.className = 'w';
      el.textContent = span.word;
      if (i) els.current.append(' ');
      els.current.append(el);
      return { el, span, p: -1 };
    });
  }

  function paintCurrentLine(lineP, fills) {
    words.forEach((w, i) => {
      const p = Math.round((fills ? fills[i] : wordProgress(w.span, lineP)) * 1000) / 10;
      if (p !== w.p) {
        w.p = p;
        w.el.style.setProperty('--p', `${p}%`);
      }
    });
  }

  /** Pausa longa na letra: no lugar da linha atual, "--------------" que some nos últimos 8 s (prepare-se!). */
  function buildGapLine() {
    els.current.textContent = '';
    gapEl = document.createElement('span');
    gapEl.className = 'gap-dashes';
    els.current.append(gapEl);
    words = [];
    lastDashes = -1;
  }

  function paintGap(dashes) {
    if (dashes === lastDashes) return;
    lastDashes = dashes;
    gapEl.textContent = '-'.repeat(dashes);
  }

  return {
    /** Troca a letra (lista de linhas {start, end, text, words?}) e limpa a tela. */
    setCues(next) {
      cues = Array.isArray(next) ? next : [];
      parts = duet ? splitParts(cues) : [];
      clear();
    },

    /** Liga o modo dueto (divisão automática das linhas entre os dois cantores) ou volta ao normal. */
    setDuet(on) {
      duet = Boolean(on);
      parts = duet ? splitParts(cues) : [];
      lastKey = '';
    },

    setOffset(seconds) {
      offset = Number(seconds) || 0;
    },

    clear() {
      cues = [];
      clear();
    },

    /** Desenha o que vale no instante `time` (segundos) da música. */
    render(time) {
      const t = time + offset;
      const gap = gapDisplay(cues, t);
      let { current, next } = locate(cues, t);
      if (gap) {
        current = -1; // dentro de uma pausa longa nenhuma linha está sendo cantada, mesmo que o `end` da anterior diga o contrário
        next = gap.next;
      }
      const text = (i) => cues[i]?.text ?? '';
      const anchor = current >= 0 ? current : next;
      const key = `${current}|${anchor}|${gap ? 'gap' : ''}`;
      if (key !== lastKey) {
        lastKey = key;
        els.prev.textContent = text(anchor - 1);
        if (gap) buildGapLine();
        else buildCurrentLine(current >= 0 ? text(current) : cues.length ? '' : '♪ Sem letra para esta música');
        els.next.textContent = text(current >= 0 ? current + 1 : next);
        els.next2.textContent = text(current >= 0 ? current + 2 : next + 1);
        // dueto: quem canta cada linha (o CSS pinta de verde, vermelho ou amarelo); fora do dueto o atributo some
        const part = (i) => (duet && cues[i] ? parts[i] ?? '' : '');
        mark(els.prev, part(anchor - 1));
        mark(els.current, gap ? '' : part(current));
        mark(els.next, part(current >= 0 ? current + 1 : next));
        mark(els.next2, part(current >= 0 ? current + 2 : next + 1));
      }
      if (gap) paintGap(gap.dashes);
      else paintCurrentLine(current >= 0 ? lineProgress(cues[current], t) : 0, current >= 0 ? wordFills(cues[current], words.length, t) : null);
    },

    get cues() {
      return cues;
    },

    get offset() {
      return offset;
    },
  };
}
