import { Type } from '@sinclair/typebox';
import { VIDEO_ID_PATTERN } from '../agents/agents.ts';

/** Publishes the app version: whoever has the app below it sees the notice (and, below the minimum, the server refuses work). */
export const ReleaseBody = Type.Object(
  {
    latest: Type.String({ maxLength: 40 }),
    minimum: Type.String({ maxLength: 40 }),
    notes: Type.String({ maxLength: 1000 }),
    url: Type.String({ maxLength: 600 }),
  },
  { additionalProperties: false },
);

/** Creates or changes an e-mail's permissions ("*" for pairing = any e-mail). */
export const EmailRuleBody = Type.Object(
  {
    email: Type.String({ maxLength: 254 }),
    can_pair: Type.Boolean(),
    can_cloud: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** A song in the cloud, by its YouTube id. */
export const VideoIdParams = Type.Object({ id: Type.String({ pattern: VIDEO_ID_PATTERN }) });
