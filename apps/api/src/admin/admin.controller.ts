import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { Static } from '@sinclair/typebox';
import { ReleaseError } from '../release/release.ts';
import { ReleaseService } from '../release/release.service.ts';
import { HttpError } from '../rooms.js';
import { TypeBoxPipe } from '../validation.ts';
import { AdminGuard } from './admin.guard.ts';
import { EmailRuleBody, ReleaseBody, VideoIdParams } from './admin.schemas.ts';
import { AdminService } from './admin.service.ts';

/** The admin page's API, under its secret address (ADMIN_PATH): /<ADMIN_PATH>/api/... */
@Controller('api')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly release: ReleaseService,
  ) {}

  @Get('state')
  state() {
    return this.admin.state();
  }

  @Put('release')
  async publish(@Body(new TypeBoxPipe(ReleaseBody)) body: Static<typeof ReleaseBody>) {
    try {
      await this.release.set(body);
    } catch (error) {
      if (error instanceof ReleaseError) throw new HttpError(400, error.code, error.message);
      throw error;
    }
    return { ok: true, release: this.release.get() };
  }

  /** The .env applies again (APP_LATEST_VERSION, APP_MIN_VERSION, APP_NOTES, APP_DOWNLOAD_URL). */
  @Delete('release')
  async clearRelease() {
    return { ok: true, removed: await this.release.clear(), release: this.release.get() };
  }

  @Put('emails')
  setEmailRule(@Body(new TypeBoxPipe(EmailRuleBody)) body: Static<typeof EmailRuleBody>) {
    return this.admin.setEmailRule(body);
  }

  @Delete('emails/:email')
  deleteEmailRule(@Param('email') email: string) {
    return this.admin.deleteEmailRule(String(email));
  }

  @Delete('devices/:id')
  revokeDevice(@Param('id') id: string) {
    return this.admin.revokeDevice(id);
  }

  @Delete('cloud/:id')
  removeFromCloud(@Param(new TypeBoxPipe(VideoIdParams)) { id }: Static<typeof VideoIdParams>) {
    return this.admin.removeFromCloud(id);
  }

  @Post('cloud/:id/unblock')
  @HttpCode(200)
  unblock(@Param(new TypeBoxPipe(VideoIdParams)) { id }: Static<typeof VideoIdParams>) {
    return this.admin.unblock(id);
  }
}
