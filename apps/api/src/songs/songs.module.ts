import { Module } from '@nestjs/common';
import { SongsController } from './songs.controller.ts';

/** The song routes. The SongService itself comes from app.ts (the Rooms use it too) through LegacyModule. */
@Module({ controllers: [SongsController] })
export class SongsModule {}
