import { Module } from '@nestjs/common';
import { CacheCleaner } from './cache-cleaner.service.ts';

@Module({ providers: [CacheCleaner], exports: [CacheCleaner] })
export class CacheModule {}
