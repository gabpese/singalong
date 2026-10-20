import { Type } from '@sinclair/typebox';
import { MAX_WAIT_MS } from '../jobs.js';
import { MAX_LIBRARY_BATCH, MAX_NAME, VIDEO_ID_PATTERN } from './agents.ts';

/** One of these strings, as a JSON Schema enum: a mismatch reads "must be equal to one of the allowed values". */
export const OneOf = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: 'string', enum: [...values] });

const Text = Type.String({ maxLength: 500 });
const JobId = Type.String({ pattern: '^[A-Za-z0-9_-]{11,14}$' });
/** What the agent tells about a job while it runs and when it ends. */
const JobFields = {
  stage: Type.Optional(Text),
  error: Type.Optional(Text),
  error_code: Type.Optional(Type.String({ maxLength: 60 })),
  retry: Type.Optional(Type.String({ maxLength: 20 })),
};
const Email = Type.String({ maxLength: 254 });

/** Open: the app checks it before it even pairs. `?current=1.2.3` → what to do. */
export const VersionQuery = Type.Object({ current: Type.Optional(Type.String({ maxLength: 60 })) });

export const PairStartBody = Type.Object({ email: Type.Optional(Email) }, { additionalProperties: false });
export const PairRequestBody = Type.Object({ email: Email }, { additionalProperties: false });
export const PairCompleteBody = Type.Object(
  { code: Type.String({ minLength: 4, maxLength: 20 }), name: Type.Optional(Type.String({ maxLength: 60 })) },
  { additionalProperties: false },
);

/** The owner's statistics over the last `days` days. */
export const StatsQuery = Type.Object({ days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365, default: 30 })) });

export const SessionBody = Type.Object(
  {
    display_name: Type.String({ minLength: 1, maxLength: MAX_NAME * 2 }),
    resume_id: Type.Optional(Type.String({ maxLength: 64 })),
    // the agent's local media server (http://127.0.0.1:port/token): where the browser fetches the Session's songs
    media_base: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const HeartbeatBody = Type.Object(
  { version: Type.Optional(Type.String({ maxLength: 40 })), hardware: Type.Optional(Type.Object({})), media_base: Type.Optional(Type.String({ maxLength: 200 })) },
  { additionalProperties: false },
);

const VideoId = Type.String({ pattern: VIDEO_ID_PATTERN });
export const VideoIdParams = Type.Object({ id: VideoId });
export const CloudMissingBody = Type.Object({ ids: Type.Array(VideoId, { maxItems: 200 }) }, { additionalProperties: false });
export const LibraryBody = Type.Object({ songs: Type.Array(Type.Object({}), { maxItems: MAX_LIBRARY_BATCH }) }, { additionalProperties: false });

/** How long a claim may wait for work (long poll). */
export const WaitBody = Type.Object({ wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })) }, { additionalProperties: false });

export const JobParams = Type.Object({ id: JobId });
export const JobProgressBody = Type.Object(JobFields, { additionalProperties: false });
export const JobCompleteBody = Type.Object(
  { status: OneOf(['ready', 'needs_lyrics', 'failed']), ...JobFields },
  { additionalProperties: false },
);

const SearchItem = Type.Object(
  {
    video_id: Type.String({ pattern: '^[A-Za-z0-9_-]{11}$' }),
    title: Type.String({ maxLength: 300 }),
    channel: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    duration: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { additionalProperties: false },
);
export const SearchParams = Type.Object({ id: Type.String({ maxLength: 64 }) });
export const SearchResultBody = Type.Object(
  { results: Type.Optional(Type.Array(SearchItem, { maxItems: 20 })), error: Type.Optional(Text) },
  { additionalProperties: false, minProperties: 1 },
);

export const ExportParams = Type.Object({ id: JobId, pitch: Type.Integer({ minimum: -6, maximum: 6 }) });
export const ExportStateBody = Type.Object(
  { status: OneOf(['processing', 'ready', 'failed']), error: Type.Optional(Text) },
  { additionalProperties: false },
);
