import { Module } from '@nestjs/common';
import { ReleaseModule } from '../release/release.module.ts';
import { AdminController } from './admin.controller.ts';
import { AdminGuard } from './admin.guard.ts';
import { AdminService } from './admin.service.ts';

/** Mounted only when the administration exists (ADMIN_TOKEN and ADMIN_PATH), under the secret address: see AppModule. */
@Module({ imports: [ReleaseModule], controllers: [AdminController], providers: [AdminService, AdminGuard] })
export class AdminModule {}
