import type { DatabaseSync } from 'node:sqlite';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, SqliteDriver } from '@mikro-orm/sql';
import { entities } from './entities.ts';
import { Migration20261020000000_baseline } from './migrations/Migration20261020000000_baseline.ts';
import { SharedSqliteDialect } from './sqlite-dialect.ts';

/** The migrations, in order. Listed here rather than found on disk, so the compiled API carries exactly these. */
export const migrations = [{ name: 'Migration20261020000000_baseline', class: Migration20261020000000_baseline }];

/** MikroORM over the connection db.js opened (ADR 0017), with the migrations above. */
export function ormOptions(connection: DatabaseSync) {
  return defineConfig({
    driver: SqliteDriver,
    dbName: connection.location() ?? ':memory:',
    driverOptions: new SharedSqliteDialect(connection),
    entities,
    extensions: [Migrator],
    migrations: { migrationsList: migrations, snapshot: false, silent: true },
    debug: false,
  });
}
