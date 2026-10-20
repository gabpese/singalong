import { type DynamicModule, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { DatabaseSync } from 'node:sqlite';
import { ormOptions } from './database/orm.ts';
import { DB, HealthController, JOBS, type ReadinessDeps, STORAGE } from './health.controller.ts';

/** The services built before Nest (db.js, the job store, the storage), handed to the modules that need them. */
export interface AppDeps extends ReadinessDeps {
  db: ReadinessDeps['db'] & { connection: DatabaseSync };
}

/**
 * The API's root module. The areas move here one by one (ROADMAP, step 3); until then their routes stay Fastify plugins
 * registered by app.ts.
 */
@Module({})
export class AppModule {
  static forRoot({ db, jobs, storage }: AppDeps): DynamicModule {
    return {
      module: AppModule,
      // the request context comes with the first area that uses the ORM: each request, WebSocket message and timer gets its own
      imports: [MikroOrmModule.forRoot({ ...ormOptions(db.connection), registerRequestContext: false })],
      controllers: [HealthController],
      providers: [
        { provide: DB, useValue: db },
        { provide: JOBS, useValue: jobs },
        { provide: STORAGE, useValue: storage },
      ],
    };
  }
}
