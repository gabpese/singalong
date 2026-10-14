import { t } from '../i18n/index.js';

// Dueto: quem canta cada linha da letra. Por enquanto a divisão é AUTOMÁTICA; o desenho deixa espaço para evoluir (por exemplo,
// uma divisão escolhida à mão pelos cantores, que entraria no lugar do resultado desta função).

/** As partes de cada linha: 'a' (o cantor que adicionou a música), 'b' (o convidado) ou 'both' (os dois juntos). */
export const PARTS = ['a', 'b', 'both'];

/** Texto da linha sem maiúsculas, pontuação e espaços repetidos: "Oh, oh!" e "oh oh" são a mesma linha. */
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Linhas muito curtas ("oh", "yeah") repetem em qualquer música e não indicam um refrão. */
const MIN_CHORUS_CHARS = 8;

/**
 * Divide a letra entre os dois cantores:
 *  - linhas que se REPETEM (o refrão) são cantadas pelos dois ('both');
 *  - as demais se alternam, uma linha para cada cantor (a, b, a, b...), começando por quem adicionou a música;
 *  - linhas vazias não têm parte (null) e não contam na alternância.
 * Se os cantores escolheram a divisão (`assigned`, texto a b * -) e ela combina com a letra, vale ela.
 * Devolve um array do mesmo tamanho de `cues`.
 *
 * @param {Array<{ text?: string }>} cues
 * @param {string | null | undefined} [assigned] a divisão escolhida pelos cantores
 */
export function splitParts(cues, assigned = null) {
  const chosen = decodeParts(assigned, cues?.length ?? 0);
  if (chosen) return chosen;
  const keys = (cues ?? []).map((cue) => normalize(cue?.text));
  const counts = new Map();
  for (const key of keys) if (key.length >= MIN_CHORUS_CHARS) counts.set(key, (counts.get(key) ?? 0) + 1);
  let turn = 0;
  return keys.map((key) => {
    if (!key) return null;
    if ((counts.get(key) ?? 0) > 1) return 'both';
    return turn++ % 2 === 0 ? 'a' : 'b';
  });
}

const PART_BY_CHAR = { a: 'a', b: 'b', '*': 'both', '-': null };
const CHAR_BY_PART = { a: 'a', b: 'b', both: '*' };

/**
 * A divisão escolhida pelos cantores (texto com `a`, `b`, `*` = os dois e `-` = ninguém, uma letra por linha da letra) como
 * a lista de partes. Se não existe, não tem o tamanho da letra (a letra mudou) ou tem letras estranhas: null, e vale a automática.
 */
export function decodeParts(text, lines) {
  if (typeof text !== 'string' || text.length !== lines || !/^[ab*-]+$/.test(text)) return null;
  return [...text].map((char) => PART_BY_CHAR[char]);
}

/** A lista de partes ('a' | 'b' | 'both' | null) como o texto que o servidor guarda. */
export const encodeParts = (parts) => parts.map((part) => CHAR_BY_PART[part] ?? '-').join('');

/** Qual é a minha parte no palco? Quem adicionou a música é o 'a' (turquesa, círculo); o convidado, o 'b' (violeta, quadrado). */
export const myPart = (item) => (item?.guest_me ? 'b' : 'a');

export const partName = (part) => t(`duet.part.${part}`);
