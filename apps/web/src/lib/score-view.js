// Textos da pontuação.

import { t } from '../i18n/index.js';
/** Quadros avaliados (uma leitura a cada 100 ms) para a nota valer: 5 s cantados. Evita nota alta/baixa de música que mal começou. */
export const MIN_SCORED_FRAMES = 50;

export function finalMessage(score) {
  if (score >= 90) return t('score.msg90');
  if (score >= 75) return t('score.msg75');
  if (score >= 55) return t('score.msg55');
  if (score >= 30) return t('score.msg30');
  return t('score.msg0');
}
