// Translated text with bold stretches: **like this** becomes <strong>like this</strong> (word order changes from language to language,
// so the emphasis is part of the translated text, not of the code).
import { Fragment, type ReactNode } from 'react';
import { t } from './index.js';

export function tRich(key: string, vars?: Record<string, string | number>): ReactNode {
  return t(key, vars)
    .split('**')
    .map((part: string, index: number) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : <Fragment key={index}>{part}</Fragment>));
}
