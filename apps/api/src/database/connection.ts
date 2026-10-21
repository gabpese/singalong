import { DatabaseSync } from 'node:sqlite';

/**
 * Opens the SQLite database: a file, or `:memory:` in the tests. MikroORM works over this connection (sqlite-dialect.ts), and
 * the API closes it after MikroORM. The foreign keys are enforced, as SQLite does not do by default.
 */
export function openConnection(path = ':memory:'): DatabaseSync {
  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA foreign_keys = ON');
  return connection;
}
