// Os bichinhos (blobatar) de quem canta uma música: o de quem adicionou e, num dueto já aceito, também o do convidado, um encostado
// no outro. Saem do nome da pessoa, como na sala de espera da TV, então cada um tem o mesmo bichinho em todas as telas.
// `animate`: só onde há um por vez na tela (quem está cantando na TV); nas listas eles ficam parados (uma <img> cada, mais leve).
import { Blobatar } from '@blobatar/react';
import type { ComponentProps } from 'react';
import 'blobatar/motion.css';
import type { QueueItem } from '../lib/types.ts';

export function singerNames(item: Pick<QueueItem, 'added_by' | 'guest'>): string[] {
  return item.guest?.status === 'accepted' ? [item.added_by, item.guest.name] : [item.added_by];
}

export type BlobExpression = ComponentProps<typeof Blobatar>['expression'];

export function SingerBlobs({ item, animate = false, expression }: { item: Pick<QueueItem, 'added_by' | 'guest'>; animate?: boolean; expression?: BlobExpression }) {
  const names = singerNames(item);
  return (
    <span className={`singer-blobs${names.length > 1 ? ' duo' : ''}`} aria-hidden="true">
      {names.map((name, index) =>
        animate ? (
          <Blobatar key={`${index}-${name}`} name={name} background={false} animate="always" expression={expression} className="blob" />
        ) : (
          <Blobatar key={`${index}-${name}`} name={name} background={false} expression={expression} className="blob" alt="" />
        ),
      )}
    </span>
  );
}
