import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, RouterModule } from '@nestjs/core';
import { adminPathOf } from './admin/admin-path.ts';
import { AdminModule } from './admin/admin.module.ts';
import { AgentsModule } from './agents/agents.module.ts';
import { CacheModule } from './cache/cache.module.ts';
import { HealthController } from './health.controller.ts';
import { HttpErrorFilter } from './http-error.filter.ts';
import { LegacyModule, type LegacyServices } from './legacy.module.ts';
import { ReleaseModule } from './release/release.module.ts';
import { SongsModule } from './songs/songs.module.ts';

/**
 * The API's root module. The areas move here one by one (ROADMAP, step 3); until then their routes stay Fastify plugins
 * registered by app.ts, and the services they share reach Nest through LegacyModule.
 */
@Module({})
export class AppModule {
  static forRoot(services: LegacyServices): DynamicModule {
    const adminPath = adminPathOf(services.config);
    return {
      module: AppModule,
      imports: [
        // MikroORM included: the database work runs with a fresh EntityManager per call, in a request, a WebSocket message
        // or a timer alike
        LegacyModule.forRoot(services),
        ReleaseModule,
        CacheModule,
        SongsModule,
        AgentsModule,
        ...(adminPath ? [AdminModule, RouterModule.register([{ path: adminPath, module: AdminModule }])] : []),
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
    };
  }
}
