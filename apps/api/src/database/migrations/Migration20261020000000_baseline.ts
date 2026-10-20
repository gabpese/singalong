import { Migration } from '@mikro-orm/migrations';

/**
 * The starting point of the migrations. It changes nothing: db.js's frozen schema already builds this database (a new one)
 * or brings an older one up to date, before MikroORM starts. Every later change to the schema is a migration after this one.
 */
export class Migration20261020000000_baseline extends Migration {
  override async up(): Promise<void> {}
}
