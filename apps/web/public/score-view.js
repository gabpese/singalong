// Textos da pontuação.

/** Quadros avaliados (50 ms cada) para a nota valer: 5 s cantados. Evita nota alta/baixa de música que mal começou. */
export const MIN_SCORED_FRAMES = 100;

export function finalMessage(score) {
  if (score >= 90) return 'Show! Afinação de cantor profissional.';
  if (score >= 75) return 'Mandou muito bem!';
  if (score >= 55) return 'Boa! Está pegando o jeito.';
  if (score >= 30) return 'Foi na raça. Tente de novo!';
  return 'Quase em silêncio... cadê a voz?';
}
