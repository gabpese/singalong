// The database as MikroORM sees it: one entity per table, describing exactly what db.js's frozen schema builds and the
// migrations then change (a test compares them). Entities hold data and explicit relations only; the rules stay in the
// services (ADR 0017). Times are milliseconds since the epoch, kept as integers like the rest of the API.
//
// A few details mirror that schema rather than MikroORM's defaults, so that no table has to be rebuilt:
// - flags are booleans stored as INTEGER with `.defaultRaw('0')` or `('1')`, where MikroORM would write `false` or `true`;
// - relations get `.index(false)`: the old schema has its own composite indexes, not one per foreign key;
// - foreign keys keep the old rules: `cascade` where the schema says so, otherwise `no action`.
import { defineEntity } from '@mikro-orm/core';

export const Device = defineEntity({
  name: 'Device',
  tableName: 'devices',
  properties: (p) => ({
    id: p.string().primary(),
    name: p.string(),
    /** Only the token's SHA-256: the token itself is never stored. The table's own UNIQUE keeps it unique. */
    tokenHash: p.string().name('token_hash'),
    createdAt: p.integer().name('created_at'),
    lastSeen: p.integer().name('last_seen').nullable(),
    revokedAt: p.integer().name('revoked_at').nullable(),
    /** The e-mail the pairing code was sent to: it decides whether the computer sends its songs to the cloud. */
    email: p.string().nullable(),
    appVersion: p.string().name('app_version').nullable(),
  }),
});

export const Session = defineEntity({
  name: 'Session',
  tableName: 'sessions',
  properties: (p) => ({
    id: p.string().primary(),
    device: p.manyToOne(Device).name('device_id').deleteRule('cascade').index(false),
    /** The nickname guests see (never the YouTube account). */
    displayName: p.string().name('display_name'),
    createdAt: p.integer().name('created_at'),
    lastSeen: p.integer().name('last_seen'),
    endedAt: p.integer().name('ended_at').nullable(),
    /** Where the browser fetches the Session's media (the agent's local media server); null = the server's storage. */
    mediaBase: p.string().name('media_base').nullable(),
  }),
  indexes: [{ name: 'idx_sessions_device', properties: ['device', 'endedAt'] }],
});

export const Room = defineEntity({
  name: 'Room',
  tableName: 'rooms',
  properties: (p) => ({
    code: p.string().primary(),
    hostToken: p.string().name('host_token'),
    fair: p.boolean().defaultRaw('0'),
    scoring: p.boolean().defaultRaw('0'),
    voice: p.boolean().defaultRaw('0'),
    voiceVolume: p.integer().name('voice_volume').default(40),
    melodyBars: p.boolean().name('melody_bars').defaultRaw('0'),
    currentItemId: p.integer().name('current_item_id').nullable(),
    /** idle | intro (the singer takes the stage; the song waits) | playing | paused */
    playback: p.string().default('idle'),
    /** Who sang last (fair rotation). */
    lastClientId: p.string().name('last_client_id').nullable(),
    createdAt: p.integer().name('created_at'),
    lastActiveAt: p.integer().name('last_active_at'),
    intermission: p.boolean().defaultRaw('1'),
    applauseItemId: p.integer().name('applause_item_id').nullable(),
    applauseUntil: p.integer().name('applause_until').nullable(),
    stageUntil: p.integer().name('stage_until').nullable(),
    /** The Session that owns the Room; null = a Room without one (the classic worker). */
    session: p.manyToOne(Session).name('session_id').nullable().deleteRule('no action').index(false),
  }),
});

export const QueueItem = defineEntity({
  name: 'QueueItem',
  tableName: 'queue_items',
  properties: (p) => ({
    id: p.integer().primary().autoincrement(),
    room: p.manyToOne(Room).name('room_code').deleteRule('cascade').index(false),
    videoId: p.string().name('video_id'),
    title: p.string().nullable(),
    artist: p.string().nullable(),
    addedBy: p.string().name('added_by'),
    clientId: p.string().name('client_id'),
    pitch: p.integer().default(0),
    /** Backing vocals' level (0..100 %). */
    backing: p.integer().default(0),
    /** The original voice's level, as a guide for singing (0..100 %). */
    guide: p.integer().default(0),
    position: p.integer(),
    /** queued | playing | done | skipped */
    status: p.string().default('queued'),
    createdAt: p.integer().name('created_at'),
    playedAt: p.integer().name('played_at').nullable(),
    /** The final score (0..100), when the Room scores. */
    score: p.integer().nullable(),
    /** Reactions the phones sent while the song played. */
    cheers: p.integer().default(0),
    /** Duet: the person invited to sing along (their client_id never leaves the server). */
    guestClientId: p.string().name('guest_client_id').nullable(),
    guestName: p.string().name('guest_name').nullable(),
    /** pending (invitation sent) | accepted (sings along) */
    guestStatus: p.string().name('guest_status').nullable(),
  }),
  indexes: [{ name: 'idx_items_room', properties: ['room', 'status', 'position'] }],
});

export const SongSettings = defineEntity({
  name: 'SongSettings',
  tableName: 'song_settings',
  properties: (p) => ({
    videoId: p.string().name('video_id').primary(),
    lyricOffset: p.double().name('lyric_offset').columnType('real').default(0),
    /** Duet: who sings each lyrics line (a b * -), chosen by the singers; null = automatic. */
    parts: p.string().nullable(),
    lastPlayedAt: p.integer().name('last_played_at').nullable(),
  }),
});

/** The app version published from the admin page (a single row, id 1); when present, it wins over the APP_* variables. */
export const AppRelease = defineEntity({
  name: 'AppRelease',
  tableName: 'app_release',
  properties: (p) => ({
    id: p.integer().primary().autoincrement(false),
    latest: p.string().default(''),
    minimum: p.string().default(''),
    notes: p.string().default(''),
    url: p.string().default(''),
    updatedAt: p.integer().name('updated_at'),
  }),
});

export const PairCode = defineEntity({
  name: 'PairCode',
  tableName: 'pair_codes',
  properties: (p) => ({
    codeHash: p.string().name('code_hash').primary(),
    expiresAt: p.integer().name('expires_at'),
    email: p.string().nullable(),
  }),
});

/** A song that played in one of an owner's Rooms: the owner's statistics. No client_id: the person becomes a one-way key. */
export const PlayLog = defineEntity({
  name: 'PlayLog',
  tableName: 'play_log',
  properties: (p) => ({
    id: p.integer().primary().autoincrement(),
    device: p.manyToOne(Device).name('device_id').deleteRule('cascade').index(false),
    sessionId: p.string().name('session_id'),
    videoId: p.string().name('video_id'),
    title: p.string().nullable(),
    artist: p.string().nullable(),
    /** The name as the person typed it. */
    singer: p.string(),
    /** The same person, without the client_id (a short hash). */
    singerKey: p.string().name('singer_key'),
    duet: p.boolean().defaultRaw('0'),
    score: p.integer().nullable(),
    cheers: p.integer().default(0),
    /** done | skipped */
    outcome: p.string(),
    endedAt: p.integer().name('ended_at'),
  }),
  indexes: [{ name: 'idx_play_log_device', properties: ['device', 'endedAt'] }],
});

/** Who may get a pairing code and whose computers send songs to the cloud, managed on the admin page ('*' = any e-mail). */
export const EmailRule = defineEntity({
  name: 'EmailRule',
  tableName: 'email_rules',
  properties: (p) => ({
    email: p.string().primary(),
    canPair: p.boolean().name('can_pair').defaultRaw('0'),
    canCloud: p.boolean().name('can_cloud').defaultRaw('0'),
    createdAt: p.integer().name('created_at'),
  }),
});

/** Songs the admin took off the cloud: computers do not send them again. */
export const CloudBlocked = defineEntity({
  name: 'CloudBlocked',
  tableName: 'cloud_blocked',
  properties: (p) => ({
    videoId: p.string().name('video_id').primary(),
    blockedAt: p.integer().name('blocked_at'),
  }),
});

/** The owner's catalog: the songs ON their computer. The cloud only knows what the agent publishes (meta.json and the files). */
export const AgentSong = defineEntity({
  name: 'AgentSong',
  tableName: 'agent_songs',
  properties: (p) => ({
    device: p.manyToOne(Device).name('device_id').primary().deleteRule('cascade').index(false),
    videoId: p.string().name('video_id').primary(),
    /** The song's meta.json, as JSON text. */
    meta: p.text(),
    /** { instrumental, lyrics, melody, backing, vocals, exports: [keys] }, as JSON text. */
    files: p.text(),
    updatedAt: p.integer().name('updated_at'),
  }),
});

export const entities = [Device, Session, Room, QueueItem, SongSettings, AppRelease, PairCode, PlayLog, EmailRule, CloudBlocked, AgentSong];
