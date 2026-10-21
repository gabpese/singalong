import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SqliteDialect } from 'kysely';

/**
 * A Kysely dialect over a `node:sqlite` connection that is already open: the one connection.ts opens, with the foreign keys
 * enforced. The tests reach the same database, the in-memory one included. It follows MikroORM's own `NodeSqliteDialect`,
 * which can only open a new connection. Closing is left to whoever opened it (app.ts closes it after MikroORM).
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
