// Texto traduzido com trechos em negrito: **assim** vira <strong>assim</strong> (a ordem das palavras muda de língua para língua,
// então o destaque faz parte do texto traduzido, e não do código).
import { Fragment, type ReactNode } from 'react';
import { t } from './index.js';

export function tRich(key: string, vars?: Record<string, string | number>): ReactNode {
  return t(key, vars)
    .split('**')
    .map((part: string, index: number) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : <Fragment key={index}>{part}</Fragment>));
}
