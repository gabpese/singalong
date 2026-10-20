import { Controller, Get, Inject } from '@nestjs/common';
import type { AppConfig } from '../app.ts';
import { downloadPage, downloadsFor } from '../installers.js';
import type { Download, PublicConfig } from '../protocol.ts';
import { CONFIG } from '../tokens.ts';
import { ReleaseService } from './release.service.ts';

/** What the landing page needs: the public address (for the QR code) and, when set, where to download the app and its latest version. */
@Controller('api')
export class PublicConfigController {
  constructor(
    private readonly release: ReleaseService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('config')
  get(): PublicConfig {
    const published = this.release.get();
    return {
      public_url: this.config.publicUrl || null,
      app_download_url: /^https?:\/\//i.test(published.url ?? '') ? published.url! : null,
      app_latest_version: published.latest || null,
      app_page_url: downloadPage(published.url), // to see every version (the GitHub files folder does not open in a browser)
      app_downloads: downloadsFor(published.url) as Download[], // each system's installer, with its fixed file name
    };
  }
}
