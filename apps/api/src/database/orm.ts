import type { DatabaseSync } from 'node:sqlite';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, SqliteDriver } from '@mikro-orm/sql';
import { entities } from './entities.ts';
import { Migration20261019000000_initial_schema } from './migrations/Migration20261019000000_initial_schema.ts';
import { Migration20261020000000_baseline } from './migrations/Migration20261020000000_baseline.ts';
import { Migration20261020160000_primary_keys_not_null } from './migrations/Migration20261020160000_primary_keys_not_null.ts';
import { SharedSqliteDialect } from './sqlite-dialect.ts';

/** The migrations, in order. Listed here rather than found on disk, so the compiled API carries exactly these. */
export const migrations = [
  { name: 'Migration20261019000000_initial_schema', class: Migration20261019000000_initial_schema },
  { name: 'Migration20261020000000_baseline', class: Migration20261020000000_baseline },
  { name: 'Migration20261020160000_primary_keys_not_null', class: Migration20261020160000_primary_keys_not_null },
];

/**
 * MikroORM over the connection connection.ts opened (ADR 0017), with the migrations above. Each migration runs in a transaction of its
 * own rather than all of them in one: a migration that rebuilds tables switches the foreign keys off first, which SQLite
 * ignores inside a transaction.
 */
export function ormOptions(connection: DatabaseSync) {
  return defineConfig({
    driver: SqliteDriver,
    dbName: connection.location() ?? ':memory:',
    driverOptions: new SharedSqliteDialect(connection),
    entities,
    extensions: [Migrator],
    migrations: { migrationsList: migrations, allOrNothing: false, snapshot: false, silent: true },
    debug: false,
  });
}
