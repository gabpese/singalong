import { Module } from '@nestjs/common';
import { PublicConfigController } from './public-config.controller.ts';
import { ReleaseService } from './release.service.ts';

@Module({ controllers: [PublicConfigController], providers: [ReleaseService], exports: [ReleaseService] })
export class ReleaseModule {}
