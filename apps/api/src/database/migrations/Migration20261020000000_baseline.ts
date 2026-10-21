import { Migration } from '@mikro-orm/migrations';

/**
 * The first migration MikroORM recorded, when db.js still built the database before MikroORM started. It changes nothing;
 * that work is now the initial schema migration, listed before it.
 */
export class Migration20261020000000_baseline extends Migration {
  override async up(): Promise<void> {}
}
