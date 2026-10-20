import { Type } from '@sinclair/typebox';
import { VIDEO_ID_PATTERN } from '../agents/agents.ts';
import { LyricsChoice } from '../songs/song.schemas.ts';
import { OneOf } from '../validation.ts';

const Code = Type.String({ pattern: '^[A-Za-z0-9]{4,8}$' });
const VideoId = Type.String({ pattern: VIDEO_ID_PATTERN });

export const RoomParams = Type.Object({ code: Code });
export const ItemParams = Type.Object({ code: Code, itemId: Type.Integer({ minimum: 1 }) });
export const SongParams = Type.Object({ code: Code, videoId: VideoId });
export const PlayerParams = Type.Object({ code: Code, action: OneOf(['pause', 'resume', 'skip', 'start']) });

/** The Host's settings for the Room. */
export const SettingsBody = Type.Object(
  {
    fair: Type.Optional(Type.Boolean()),
    scoring: Type.Optional(Type.Boolean()),
    voice: Type.Optional(Type.Boolean()),
    voice_volume: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    melody_bars: Type.Optional(Type.Boolean()),
    intermission: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** A song for the Queue: a YouTube link or a song id, how to get its lyrics, and who asks. */
export const AddBody = Type.Object(
  {
    url: Type.Optional(Type.String({ maxLength: 300 })),
    video_id: Type.Optional(VideoId),
    lyrics: Type.Optional(LyricsChoice),
    artist: Type.Optional(Type.String({ maxLength: 200 })),
    title: Type.Optional(Type.String({ maxLength: 200 })),
    display_title: Type.Optional(Type.String({ maxLength: 300 })),
    name: Type.Optional(Type.String({ maxLength: 60 })),
    pitch: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false, anyOf: [{ required: ['url'] }, { required: ['video_id'] }] },
);

export const MoveBody = Type.Object({ direction: OneOf(['up', 'down']) }, { additionalProperties: false });

/** Duet: invite someone in the Room (the `pid` from the `people` list). */
export const InviteBody = Type.Object({ pid: Type.String({ pattern: '^[a-f0-9]{10}$' }) }, { additionalProperties: false });
export const RespondBody = Type.Object({ accept: Type.Boolean() }, { additionalProperties: false });

/** A Queue song's Key (semitones), backing vocals and original voice (0..100 %). */
export const ItemSettingsBody = Type.Object(
  { pitch: Type.Optional(Type.Integer()), backing: Type.Optional(Type.Integer()), guide: Type.Optional(Type.Integer()) },
  { additionalProperties: false, minProperties: 1 },
);

/** Either the point to go to (`to`, in seconds) or how far to move (`seconds`). */
export const SeekBody = Type.Object(
  { seconds: Type.Optional(Type.Integer({ minimum: -120, maximum: 120 })), to: Type.Optional(Type.Number({ minimum: 0, maximum: 86_400 })) },
  { additionalProperties: false, oneOf: [{ required: ['seconds'] }, { required: ['to'] }] },
);

export const OffsetBody = Type.Object({ offset: Type.Number() }, { additionalProperties: false });

/** A Duet's lyrics split (who sings each line): a (singer 1), b (singer 2), * (both) and - (nobody); null = automatic. */
export const PartsBody = Type.Object({ parts: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
