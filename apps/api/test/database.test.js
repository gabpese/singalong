// MikroORM over the database db.js builds (ADR 0017): the same tables, the same connection, and migrations from a baseline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MikroORM } from '@mikro-orm/core';
import { openDb } from '../dist/db.js';
import { Room } from '../dist/database/entities.js';
import { migrations, ormOptions } from '../dist/database/orm.js';

/** A database as the API starts it: db.js's frozen schema, then the migrations (unless the test runs them itself). */
async function open({ migrate = true } = {}) {
  const db = openDb(':memory:');
  const orm = await MikroORM.init(ormOptions(db.connection));
  if (migrate) await orm.migrator.up();
  return { db, orm, close: async () => { await orm.close(); db.close(); } };
}

test('after the migrations, the entities describe exactly the database', async () => {
  const { orm, close } = await open();
  // an empty diff: no generated migration will ever try to rebuild a table that already matches
  assert.equal((await orm.schema.getUpdateSchemaSQL({ wrap: false })).trim(), '');
  await close();
});

test('the migrations run once, in order, and add no table but their own record', async () => {
  const { db, orm, close } = await open({ migrate: false });
  const tables = () => db.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  const before = tables();
  await orm.migrator.up();
  await orm.migrator.up(); // a second start runs nothing
  assert.deepEqual((await orm.migrator.getExecuted()).map((m) => m.name), migrations.map((m) => m.name));
  assert.deepEqual(tables().filter((name) => !before.includes(name)), ['mikro_orm_migrations']);
  await close();
});

test('making the primary keys NOT NULL rebuilds the tables without losing a row, a constraint or a counter', async () => {
  const { db, orm, close } = await open({ migrate: false });
  const sql = db.connection;
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
  const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
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
  assert.equal(db.addItem({ roomCode: 'ROOM', videoId: 'v4', addedBy: 'Ana', clientId: 'c1', pitch: 0, now: 2 }), 4);
  // and the foreign keys still cascade
  sql.exec("DELETE FROM rooms WHERE code = 'ROOM'; DELETE FROM devices WHERE id = 'pc'");
  assert.deepEqual(['queue_items', 'sessions', 'play_log', 'agent_songs'].map((table) => sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), [0, 0, 0, 0]);
  await close();
});

test('MikroORM and db.js read and write the same tables', async () => {
  const { db, orm, close } = await open();
  db.createRoom('OLDX', 'token-old', 1);
  const em = orm.em.fork();
  em.create(Room, { code: 'NEWX', hostToken: 'token-new', createdAt: 2, lastActiveAt: 2, scoring: true });
  await em.flush();
  assert.equal((await orm.em.fork().findOneOrFail(Room, { code: 'OLDX' })).intermission, true); // the old default, as a boolean
  assert.equal(db.getRoom('NEWX').scoring, 1);
  await close();
});

test('a db.js transaction inside an open MikroORM transaction nests as a savepoint', async () => {
  const { db, orm, close } = await open();
  await orm.em.fork().transactional(async () => {
    db.createRoom('INNR', 'token', 1);
    db.transaction(() => db.updateRoom('INNR', { fair: 1 }));
    assert.throws(() => db.transaction(() => { db.updateRoom('INNR', { scoring: 1 }); throw new Error('undo this part'); }));
  });
  assert.deepEqual([db.getRoom('INNR').fair, db.getRoom('INNR').scoring], [1, 0]);
  await close();
});
