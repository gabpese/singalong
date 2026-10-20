import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SqliteDialect } from 'kysely';

/**
 * A Kysely dialect over a `node:sqlite` connection that is already open: the one db.js owns. MikroORM and the code that still
 * uses db.js then read and write the same database, including the in-memory one the tests use. It follows MikroORM's own
 * `NodeSqliteDialect`, which can only open a new connection. Closing is left to db.js.
 */
export class SharedSqliteDialect extends SqliteDialect {
  constructor(connection: DatabaseSync) {
    super({
      database: {
        prepare(sql: string) {
          const statement = connection.prepare(sql);
          const values = (params: readonly unknown[]) => params as SQLInputValue[];
          return {
            reader: /^\s*(select|pragma|explain|with)/i.test(sql) || /\breturning\b/i.test(sql),
            all: (params: readonly unknown[]) => statement.all(...values(params)),
            run: (params: readonly unknown[]) => statement.run(...values(params)),
            get: (params: readonly unknown[]) => statement.get(...values(params)),
            iterate: (params: readonly unknown[]) => statement.iterate(...values(params)),
          };
        },
        close() {},
      },
    });
  }
}
