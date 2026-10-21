import { Migration } from '@mikro-orm/migrations';

/** The tables as the API first created them, before any migration changed them (the primary keys came later). */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS rooms (
    code            TEXT PRIMARY KEY,
    host_token      TEXT NOT NULL,
    fair            INTEGER NOT NULL DEFAULT 0,
    scoring         INTEGER NOT NULL DEFAULT 0,
    voice           INTEGER NOT NULL DEFAULT 0,
    voice_volume    INTEGER NOT NULL DEFAULT 40,
    melody_bars     INTEGER NOT NULL DEFAULT 0,
    current_item_id INTEGER,
    playback        TEXT NOT NULL DEFAULT 'idle',
    last_client_id  TEXT,
    created_at      INTEGER NOT NULL,
    last_active_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS queue_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    video_id    TEXT NOT NULL,
    title       TEXT,
    artist      TEXT,
    added_by    TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    pitch       INTEGER NOT NULL DEFAULT 0,
    backing     INTEGER NOT NULL DEFAULT 0,
    guide       INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',
    created_at  INTEGER NOT NULL,
    played_at   INTEGER,
    score       INTEGER,
    cheers      INTEGER NOT NULL DEFAULT 0,
    guest_client_id TEXT,
    guest_name      TEXT,
    guest_status    TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_items_room ON queue_items (room_code, status, position)',
  `CREATE TABLE IF NOT EXISTS song_settings (
    video_id     TEXT PRIMARY KEY,
    lyric_offset REAL NOT NULL DEFAULT 0,
    parts        TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER,
    revoked_at  INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS app_release (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    latest      TEXT NOT NULL DEFAULT '',
    minimum     TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pair_codes (
    code_hash   TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    ended_at     INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions (device_id, ended_at)',
  `CREATE TABLE IF NOT EXISTS play_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    session_id  TEXT NOT NULL,
    video_id    TEXT NOT NULL,
    title       TEXT,
    artist      TEXT,
    singer      TEXT NOT NULL,
    singer_key  TEXT NOT NULL,
    duet        INTEGER NOT NULL DEFAULT 0,
    score       INTEGER,
    cheers      INTEGER NOT NULL DEFAULT 0,
    outcome     TEXT NOT NULL,
    ended_at    INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_play_log_device ON play_log (device_id, ended_at)',
  `CREATE TABLE IF NOT EXISTS email_rules (
    email       TEXT PRIMARY KEY,
    can_pair    INTEGER NOT NULL DEFAULT 0,
    can_cloud   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_blocked (
    video_id    TEXT PRIMARY KEY,
    blocked_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_songs (
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    video_id    TEXT NOT NULL,
    meta        TEXT NOT NULL,
    files       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (device_id, video_id)
  )`,
];

/** The columns the tables gained over time, in the order they came: an older database gets the ones it lacks. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ['song_settings', 'parts', 'TEXT'],
  ['song_settings', 'last_played_at', 'INTEGER'],
  ['rooms', 'scoring', 'INTEGER NOT NULL DEFAULT 0'],
  ['rooms', 'voice', 'INTEGER NOT NULL DEFAULT 0'],
  ['rooms', 'voice_volume', 'INTEGER NOT NULL DEFAULT 40'],
  ['rooms', 'melody_bars', 'INTEGER NOT NULL DEFAULT 0'],
  ['rooms', 'intermission', 'INTEGER NOT NULL DEFAULT 1'],
  ['rooms', 'applause_item_id', 'INTEGER'],
  ['rooms', 'applause_until', 'INTEGER'],
  ['rooms', 'stage_until', 'INTEGER'],
  ['queue_items', 'score', 'INTEGER'],
  ['queue_items', 'guest_client_id', 'TEXT'],
  ['queue_items', 'guest_name', 'TEXT'],
  ['queue_items', 'guest_status', 'TEXT'],
  ['queue_items', 'backing', 'INTEGER NOT NULL DEFAULT 0'],
  ['queue_items', 'guide', 'INTEGER NOT NULL DEFAULT 0'],
  ['queue_items', 'cheers', 'INTEGER NOT NULL DEFAULT 0'],
  ['rooms', 'session_id', 'TEXT REFERENCES sessions(id)'],
  ['sessions', 'media_base', 'TEXT'],
  ['devices', 'email', 'TEXT'],
  ['pair_codes', 'email', 'TEXT'],
  ['devices', 'app_version', 'TEXT'],
];

/**
 * The schema the API started with, which db.js used to build when it opened the database (ADR 0017). It creates what a
 * database lacks and adds the columns an older one lacks, so it changes nothing on a database that db.js already brought up to
 * date. It runs first, before the baseline: the migrations after it change these tables.
 */
export class Migration20261019000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    for (const statement of TABLES) await this.execute(statement);
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const columns = (await this.execute(`PRAGMA table_info(${table})`)) as { name: string }[];
      if (!columns.some((existing) => existing.name === column)) await this.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
