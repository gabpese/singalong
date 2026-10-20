import { type Static, Type } from '@sinclair/typebox';
import { VIDEO_ID_PATTERN } from '../agents.js';

/**
 * How to get the lyrics. auto: the video's captions; lrclib: an online search; text: plain lyrics timed from another source;
 * file: LRC/SRT/VTT content with times; align: plain lyrics synced with the voice; none: the instrumental only.
 * Fastify's routes use it too (a TypeBox schema is a JSON Schema): the Room's queue takes the same choice.
 */
export const LyricsChoice = Type.Object(
  {
    source: Type.Union([Type.Literal('auto'), Type.Literal('lrclib'), Type.Literal('text'), Type.Literal('file'), Type.Literal('align'), Type.Literal('none')]),
    text: Type.Optional(Type.String({ maxLength: 100_000 })),
    // uses the online lyrics of a version with a different length, with its times (no alignment)
    loose: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const Artist = Type.Optional(Type.String({ maxLength: 200 }));
const Title = Type.Optional(Type.String({ maxLength: 200 }));

/** Adds a link: it uses the cache when ready, otherwise asks for the song to be prepared. */
export const SongBody = Type.Object(
  { url: Type.String({ maxLength: 300 }), lyrics: Type.Optional(LyricsChoice), artist: Artist, title: Title },
  { additionalProperties: false },
);

/** Changes a song's lyrics: the same choice, plus the artist and title for the online search. */
export const LyricsBody = Type.Object({ ...LyricsChoice.properties, artist: Artist, title: Title }, { additionalProperties: false });

export const SongIdParams = Type.Object({ id: Type.String({ pattern: VIDEO_ID_PATTERN }) });

export const SearchQuery = Type.Object({ q: Type.String({ minLength: 2, maxLength: 100 }) });

const Pitch = Type.Optional(Type.Integer({ minimum: -6, maximum: 6 }));
export const ExportBody = Type.Object({ pitch: Pitch }, { additionalProperties: false });
export const ExportQuery = Type.Object({ pitch: Pitch });

/** Lyrics that need text (text, file or align) sent without any. */
export function missingLyricsText(lyrics: Static<typeof LyricsChoice> | undefined): boolean {
  return Boolean(lyrics) && ['text', 'file', 'align'].includes(lyrics!.source) && !lyrics!.text?.trim();
}
