// MikroORM over the database db.js builds (ADR 0017): the same tables, the same connection, and migrations from a baseline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MikroORM } from '@mikro-orm/core';
import { openDb } from '../dist/db.js';
import { Room } from '../dist/database/entities.js';
import { migrations, ormOptions } from '../dist/database/orm.js';

async function open() {
  const db = openDb(':memory:');
  const orm = await MikroORM.init(ormOptions(db.connection));
  return { db, orm, close: async () => { await orm.close(); db.close(); } };
}

test('the entities describe exactly the database the frozen schema builds', async () => {
  const { orm, close } = await open();
  // an empty diff: no generated migration will ever try to rebuild a table that already matches
  assert.equal((await orm.schema.getUpdateSchemaSQL({ wrap: false })).trim(), '');
  await close();
});

test('the migrations start from a baseline that changes nothing and is recorded once', async () => {
  const { db, orm, close } = await open();
  const tables = () => db.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  const before = tables();
  await orm.migrator.up();
  await orm.migrator.up(); // a second start runs nothing
  assert.deepEqual((await orm.migrator.getExecuted()).map((m) => m.name), migrations.map((m) => m.name));
  assert.deepEqual(tables().filter((name) => !before.includes(name)), ['mikro_orm_migrations']);
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
