import { Migration } from '@mikro-orm/migrations';

/** A table as db.js's schema builds it (every column it gained over time included), now with NOT NULL on its primary key. */
interface Table {
  name: string;
  /** Column definitions; each starts with the column's name. */
  columns: string[];
  indexes?: string[];
}

const TABLES: Table[] = [
  {
    name: 'devices',
    columns: [
      'id TEXT NOT NULL PRIMARY KEY',
      'name TEXT NOT NULL',
      'token_hash TEXT NOT NULL UNIQUE',
      'created_at INTEGER NOT NULL',
      'last_seen INTEGER',
      'revoked_at INTEGER',
      'email TEXT',
      'app_version TEXT',
    ],
  },
  {
    name: 'sessions',
    columns: [
      'id TEXT NOT NULL PRIMARY KEY',
      'device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
      'display_name TEXT NOT NULL',
      'created_at INTEGER NOT NULL',
      'last_seen INTEGER NOT NULL',
      'ended_at INTEGER',
      'media_base TEXT',
    ],
    indexes: ['CREATE INDEX idx_sessions_device ON sessions (device_id, ended_at)'],
  },
  {
    name: 'rooms',
    columns: [
      'code TEXT NOT NULL PRIMARY KEY',
      'host_token TEXT NOT NULL',
      'fair INTEGER NOT NULL DEFAULT 0',
      'scoring INTEGER NOT NULL DEFAULT 0',
      'voice INTEGER NOT NULL DEFAULT 0',
      'voice_volume INTEGER NOT NULL DEFAULT 40',
      'melody_bars INTEGER NOT NULL DEFAULT 0',
      'current_item_id INTEGER',
      "playback TEXT NOT NULL DEFAULT 'idle'",
      'last_client_id TEXT',
      'created_at INTEGER NOT NULL',
      'last_active_at INTEGER NOT NULL',
      'intermission INTEGER NOT NULL DEFAULT 1',
      'applause_item_id INTEGER',
      'applause_until INTEGER',
      'stage_until INTEGER',
      'session_id TEXT REFERENCES sessions(id)',
    ],
  },
  {
    name: 'queue_items',
    columns: [
      'id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT',
      'room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE',
      'video_id TEXT NOT NULL',
      'title TEXT',
      'artist TEXT',
      'added_by TEXT NOT NULL',
      'client_id TEXT NOT NULL',
      'pitch INTEGER NOT NULL DEFAULT 0',
      'backing INTEGER NOT NULL DEFAULT 0',
      'guide INTEGER NOT NULL DEFAULT 0',
      'position INTEGER NOT NULL',
      "status TEXT NOT NULL DEFAULT 'queued'",
      'created_at INTEGER NOT NULL',
      'played_at INTEGER',
      'score INTEGER',
      'cheers INTEGER NOT NULL DEFAULT 0',
      'guest_client_id TEXT',
      'guest_name TEXT',
      'guest_status TEXT',
    ],
    indexes: ['CREATE INDEX idx_items_room ON queue_items (room_code, status, position)'],
  },
  {
    name: 'play_log',
    columns: [
      'id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT',
      'device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
      'session_id TEXT NOT NULL',
      'video_id TEXT NOT NULL',
      'title TEXT',
      'artist TEXT',
      'singer TEXT NOT NULL',
      'singer_key TEXT NOT NULL',
      'duet INTEGER NOT NULL DEFAULT 0',
      'score INTEGER',
      'cheers INTEGER NOT NULL DEFAULT 0',
      'outcome TEXT NOT NULL',
      'ended_at INTEGER NOT NULL',
    ],
    indexes: ['CREATE INDEX idx_play_log_device ON play_log (device_id, ended_at)'],
  },
  {
    name: 'song_settings',
    columns: ['video_id TEXT NOT NULL PRIMARY KEY', 'lyric_offset REAL NOT NULL DEFAULT 0', 'parts TEXT', 'last_played_at INTEGER'],
  },
  {
    name: 'app_release',
    columns: [
      'id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1)',
      "latest TEXT NOT NULL DEFAULT ''",
      "minimum TEXT NOT NULL DEFAULT ''",
      "notes TEXT NOT NULL DEFAULT ''",
      "url TEXT NOT NULL DEFAULT ''",
      'updated_at INTEGER NOT NULL',
    ],
  },
  { name: 'pair_codes', columns: ['code_hash TEXT NOT NULL PRIMARY KEY', 'expires_at INTEGER NOT NULL', 'email TEXT'] },
  {
    name: 'email_rules',
    columns: ['email TEXT NOT NULL PRIMARY KEY', 'can_pair INTEGER NOT NULL DEFAULT 0', 'can_cloud INTEGER NOT NULL DEFAULT 0', 'created_at INTEGER NOT NULL'],
  },
  { name: 'cloud_blocked', columns: ['video_id TEXT NOT NULL PRIMARY KEY', 'blocked_at INTEGER NOT NULL'] },
];

/**
 * Every primary key becomes NOT NULL. db.js's schema declared `TEXT PRIMARY KEY` without it, which SQLite lets hold a null,
 * so the entities had to type each key as nullable. SQLite cannot add the constraint in place, so each table is rebuilt the
 * way SQLite documents (https://www.sqlite.org/lang_altertable.html#otheralter): a new table, the rows copied, the old one
 * dropped, the new one renamed, its indexes created again. The UNIQUE and CHECK constraints and the AUTOINCREMENT counters
 * stay, which the SQL MikroORM generates for a rebuild would lose.
 *
 * The foreign keys are switched off for the rebuild: with them on, dropping `rooms` would delete every Queue item in cascade,
 * and dropping `devices` every Session, play and catalog entry. SQLite ignores that switch inside a transaction, so this
 * migration runs outside MikroORM's and opens its own (orm.ts runs each migration on its own for this).
 */
export class Migration20261020160000_primary_keys_not_null extends Migration {
  override isTransactional(): boolean {
    return false;
  }

  override async up(): Promise<void> {
    const [{ foreign_keys: enforced }] = await this.execute('PRAGMA foreign_keys');
    const brokenKeys = async () => (await this.execute('PRAGMA foreign_key_check')).length;
    await this.execute('PRAGMA foreign_keys = OFF');
    try {
      const brokenBefore = await brokenKeys();
      await this.execute('BEGIN');
      try {
        for (const table of TABLES) await this.rebuild(table);
        if ((await brokenKeys()) > brokenBefore) throw new Error('Rebuilding the tables broke a foreign key.');
        await this.execute('COMMIT');
      } catch (error) {
        await this.execute('ROLLBACK');
        throw error;
      }
    } finally {
      await this.execute(`PRAGMA foreign_keys = ${enforced ? 'ON' : 'OFF'}`);
    }
  }

  private async rebuild({ name, columns, indexes = [] }: Table): Promise<void> {
    const names = columns.map((column) => column.split(' ')[0]).join(', ');
    await this.execute(`CREATE TABLE new_${name} (${columns.join(', ')})`);
    // the column names, not *: a database that gained its columns over time keeps them in another order
    await this.execute(`INSERT INTO new_${name} (${names}) SELECT ${names} FROM ${name}`);
    if (columns[0].includes('AUTOINCREMENT')) {
      // the counter, not just the largest id left: the id of a deleted row is never handed out again
      await this.execute(`DELETE FROM sqlite_sequence WHERE name = 'new_${name}'`);
      await this.execute(`INSERT INTO sqlite_sequence (name, seq) SELECT 'new_${name}', seq FROM sqlite_sequence WHERE name = '${name}'`);
    }
    await this.execute(`DROP TABLE ${name}`);
    await this.execute(`ALTER TABLE new_${name} RENAME TO ${name}`);
    for (const index of indexes) await this.execute(index);
  }
}
