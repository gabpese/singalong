import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller.ts';
import { RoomsGateway } from './rooms.gateway.ts';

/**
 * The Rooms: the HTTP routes and the WebSocket gateway. The RoomService itself comes from app.ts (the songs and the agents use
 * it too) through LegacyModule.
 */
@Module({ controllers: [RoomsController], providers: [RoomsGateway] })
export class RoomsModule {}
