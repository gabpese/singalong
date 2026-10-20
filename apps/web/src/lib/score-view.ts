// Score texts.

import { t } from '../i18n/index.ts';

/** Frames scored (one reading every 100 ms) before a score counts: 5 s of singing. Avoids a high or low score for a song that has barely started. */
export const MIN_SCORED_FRAMES = 50;

export function finalMessage(score: number): string {
  if (score >= 90) return t('score.msg90');
  if (score >= 75) return t('score.msg75');
  if (score >= 55) return t('score.msg55');
  if (score >= 30) return t('score.msg30');
  return t('score.msg0');
}
