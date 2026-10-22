// The creatures (blobatar) of whoever sings a song: the one who added it and, in an accepted duet, also the invited partner's, one leaning
// on the other. They come from the person's name, as in the TV's waiting room, so everyone has the same creature on every screen.
// `animate`: only where there is one at a time on screen (whoever is singing on the TV); in the lists they stay still (one <img> each, lighter).
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
