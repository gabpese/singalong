// The database is built by MikroORM's migrations (ADR 0017): a new one from nothing, an old one up to date, and the entities
// describe exactly what they build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Room } from '../dist/database/entities.js';
import { migrations } from '../dist/database/orm.js';
import { fixtures, openDatabase } from './fixtures.ts';

const INITIAL = 'Migration20261019000000_initial_schema';
const BASELINE = 'Migration20261020000000_baseline';
const tablesOf = (connection) => connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
/** Every table and index as SQLite keeps them (the migrations' own record aside). */
const schemaOf = (connection) =>
  connection.prepare("SELECT type, name, sql FROM sqlite_master WHERE name != 'mikro_orm_migrations' ORDER BY name").all().map((row) => `${row.type} ${row.name}: ${row.sql}`);

test('after the migrations, the entities describe exactly the database', async () => {
  const { orm, close } = await openDatabase();
  // an empty diff: no generated migration will ever try to rebuild a table that already matches
  assert.equal((await orm.schema.getUpdateSchemaSQL({ wrap: false })).trim(), '');
  await close();
});

test('the migrations build a new database once, in order', async () => {
  const { connection, orm, close } = await openDatabase(':memory:', { migrate: false });
  assert.deepEqual(tablesOf(connection), []);
  await orm.migrator.up();
  await orm.migrator.up(); // a second start runs nothing
  assert.deepEqual((await orm.migrator.getExecuted()).map((m) => m.name), migrations.map((m) => m.name));
  assert.deepEqual(tablesOf(connection), [
    'agent_songs', 'app_release', 'cloud_blocked', 'devices', 'email_rules', 'mikro_orm_migrations', 'pair_codes', 'play_log',
    'queue_items', 'rooms', 'sessions', 'song_settings', 'sqlite_sequence',
  ]);
  assert.equal(connection.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  await close();
});

test('on a database db.js already built, the initial schema runs once and changes nothing', async () => {
  const { connection, orm, close } = await openDatabase();
  // the production database: db.js built it, and MikroORM recorded only the migrations after it
  connection.prepare('DELETE FROM mikro_orm_migrations WHERE name = ?').run(INITIAL);
  await fixtures(orm).createRoom('KEEP', 'token', 1);
  const before = schemaOf(connection);
  assert.deepEqual((await orm.migrator.getPending()).map((m) => m.name), [INITIAL]);
  await orm.migrator.up();
  assert.deepEqual(schemaOf(connection), before);
  assert.ok(await orm.em.fork().findOne(Room, { code: 'KEEP' }));
  await close();
});

test("a database from the API's first version is brought up to date, keeping its rows", async () => {
  const { connection, orm, close } = await openDatabase(':memory:', { migrate: false });
  // the tables as the first version created them, before the columns that came later
  connection.exec(`
    CREATE TABLE rooms (code TEXT PRIMARY KEY, host_token TEXT NOT NULL, fair INTEGER NOT NULL DEFAULT 0, current_item_id INTEGER,
      playback TEXT NOT NULL DEFAULT 'idle', last_client_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
    CREATE TABLE queue_items (id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      video_id TEXT NOT NULL, title TEXT, artist TEXT, added_by TEXT NOT NULL, client_id TEXT NOT NULL, pitch INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, played_at INTEGER);
    CREATE TABLE song_settings (video_id TEXT PRIMARY KEY, lyric_offset REAL NOT NULL DEFAULT 0);
    INSERT INTO rooms (code, host_token, fair, created_at, last_active_at) VALUES ('OLD1', 'token', 1, 1, 1);
    INSERT INTO queue_items (room_code, video_id, added_by, client_id, pitch, position, created_at) VALUES ('OLD1', 'v1', 'Ana', 'c1', 2, 1, 1);
    INSERT INTO song_settings VALUES ('v1', 1.5);
  `);
  await orm.migrator.up();
  assert.equal((await orm.schema.getUpdateSchemaSQL({ wrap: false })).trim(), '');
  const room = await orm.em.fork().findOneOrFail(Room, { code: 'OLD1' });
  // the old values stay; the columns that came later take their defaults
  assert.deepEqual([room.fair, room.intermission, room.voiceVolume, room.scoring], [true, true, 40, false]);
  const item = connection.prepare("SELECT pitch, backing, cheers, guest_status FROM queue_items WHERE room_code = 'OLD1'").get();
  assert.deepEqual({ ...item }, { pitch: 2, backing: 0, cheers: 0, guest_status: null });
  assert.equal((await fixtures(orm).songSettings('v1')).lyricOffset, 1.5);
  await close();
});

test('making the primary keys NOT NULL rebuilds the tables without losing a row, a constraint or a counter', async () => {
  const { connection: sql, orm, close } = await openDatabase(':memory:', { migrate: false });
  await orm.migrator.up({ to: BASELINE }); // the tables as they were before the primary keys changed
  sql.exec(`
    INSERT INTO devices (id, name, token_hash, created_at) VALUES ('pc', 'Living room', 'hash', 1);
    INSERT INTO sessions (id, device_id, display_name, created_at, last_seen) VALUES ('s1', 'pc', 'Ana', 1, 1);
    INSERT INTO rooms (code, host_token, created_at, last_active_at, session_id) VALUES ('ROOM', 'token', 1, 1, 's1');
    INSERT INTO queue_items (room_code, video_id, added_by, client_id, position, created_at)
      VALUES ('ROOM', 'v1', 'Ana', 'c1', 1, 1), ('ROOM', 'v2', 'Bia', 'c2', 2, 1), ('ROOM', 'v3', 'Cid', 'c3', 3, 1);
    DELETE FROM queue_items WHERE id = 3;
    INSERT INTO play_log (device_id, session_id, video_id, singer, singer_key, outcome, ended_at) VALUES ('pc', 's1', 'v1', 'Ana', 'k', 'done', 1);
    INSERT INTO agent_songs VALUES ('pc', 'v1', '{}', '{}', 1);
    INSERT INTO app_release (id, updated_at) VALUES (1, 1);
  `);
  const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'mikro_orm_migrations'").all().map((row) => row.name);
  // every row, its columns in name order (a rebuilt table may order them differently)
  const rows = () => tables.map((table) => sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => Object.entries(row).sort()));
  const before = rows();

  await orm.migrator.up();

  // with the foreign keys on, dropping the old tables would have deleted the Queue, the Session and the history in cascade
  assert.deepEqual(rows(), before);
  const nullableKeys = sql.prepare("SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.pk > 0 AND p.\"notnull\" = 0").all();
  assert.deepEqual(nullableKeys, []);
  assert.equal(sql.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => sql.exec("INSERT INTO rooms (code, host_token, created_at, last_active_at) VALUES (NULL, 't', 1, 1)"), /NOT NULL/);
  assert.throws(() => sql.exec("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('pc2', 'Other', 'hash', 1)"), /UNIQUE/);
  assert.throws(() => sql.exec('INSERT INTO app_release (id, updated_at) VALUES (2, 1)'), /CHECK/);
  // the deleted song's id is not handed out again
  assert.equal(await fixtures(orm).addItem({ room: 'ROOM', videoId: 'v4', addedBy: 'Ana', clientId: 'c1', now: 2 }), 4);
  // and the foreign keys still cascade
  sql.exec("DELETE FROM rooms WHERE code = 'ROOM'; DELETE FROM devices WHERE id = 'pc'");
  assert.deepEqual(['queue_items', 'sessions', 'play_log', 'agent_songs'].map((table) => sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), [0, 0, 0, 0]);
  await close();
});
