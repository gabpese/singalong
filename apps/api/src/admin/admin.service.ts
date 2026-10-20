import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { AppConfig } from '../app.ts';
import { AgentService } from '../agents/agent.service.ts';
import { CloudBlocked, Device, EmailRule } from '../database/entities.ts';
import { ReleaseService } from '../release/release.service.ts';
import { HttpError } from '../rooms.js';
import type { LocalStorage } from '../storage.js';
import { CONFIG, STORAGE } from '../tokens.ts';
import { updateInfo } from '../version.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const READY_FILES = ['instrumental.mp3', 'lyrics.json', 'meta.json'];

/**
 * What the server's owner manages on the admin page: the authorized e-mails, the paired computers and the songs in the cloud.
 * The answers keep the field names the page reads (snake_case).
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly orm: MikroORM,
    private readonly release: ReleaseService,
    @Inject(STORAGE) private readonly storage: LocalStorage,
    private readonly agents: AgentService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Everything the page shows at once. */
  async state() {
    const em = this.orm.em.fork();
    const blocked = await em.find(CloudBlocked, {}, { orderBy: { blockedAt: 'desc' } });
    const rules = await em.find(EmailRule, {}, { orderBy: { email: 'asc' } });
    const devices = await em.find(Device, {}, { orderBy: { createdAt: 'desc' } });
    const cloud = await this.cloudSongs();
    const published = this.release.get();
    return {
      // the published app version (from the page or, without it, the .env) and what the .env would say if the page's were cleared
      release: { ...published, env: this.release.env() },
      mail: { enabled: Boolean(this.config.brevoApiKey && this.config.mailFrom) },
      emails: {
        rules: rules.map((rule) => ({ email: rule.email, can_pair: rule.canPair, can_cloud: rule.canCloud })),
        fixed: { pair: this.config.pairAllowedEmails ?? [], cloud: this.config.cloudUploadEmails ?? [] }, // from the .env: they only change there
      },
      devices: await Promise.all(devices.map(async (device) => ({
        id: device.id,
        name: device.name,
        email: device.email,
        created_at: device.createdAt,
        last_seen: device.lastSeen,
        revoked: Boolean(device.revokedAt),
        cloud: await this.agents.canUploadToCloud(device),
        // the app version it reported and whether it is up to date: ok | update_available | update_required | unknown
        version: device.appVersion ?? null,
        update_status: updateInfo(device.appVersion, published).status,
      }))),
      cloud,
      cloud_total: cloud.reduce((sum, song) => sum + song.size, 0),
      blocked: blocked.map((song) => ({ video_id: song.videoId, blocked_at: song.blockedAt })),
    };
  }

  /** The prepared songs in the server's storage, newest first. */
  private async cloudSongs() {
    const songs = new Map<string, { id: string; size: number; ready: Set<string>; updated: number }>();
    for (const { key, size, mtimeMs: modified } of await this.storage.listDetailed('cache')) {
      const [, id, name] = key.split('/');
      if (!id || !name) continue;
      const entry = songs.get(id) ?? { id, size: 0, ready: new Set<string>(), updated: 0 };
      entry.size += size;
      entry.updated = Math.max(entry.updated, modified);
      entry.ready.add(name);
      songs.set(id, entry);
    }
    const cloud = [];
    for (const entry of songs.values()) {
      if (!READY_FILES.every((name) => entry.ready.has(name))) continue;
      let meta: { title?: string; artist?: string; origin?: string } = {};
      try {
        meta = JSON.parse((await this.storage.read(`cache/${entry.id}/meta.json`)).toString('utf8'));
      } catch {
        /* unreadable meta: it shows with the id only */
      }
      cloud.push({ id: entry.id, title: meta.title ?? null, artist: meta.artist ?? null, size: entry.size, updated: entry.updated, origin: meta.origin ?? 'youtube' });
    }
    return cloud.sort((a, b) => b.updated - a.updated);
  }

  /** Creates or changes an e-mail's permissions; with neither permission, the rule has nothing to keep and goes. */
  async setEmailRule({ email: typed, can_pair: canPair, can_cloud: canCloud }: { email: string; can_pair: boolean; can_cloud: boolean }) {
    const email = typed.trim().toLowerCase();
    if (email !== '*' && !EMAIL.test(email)) throw new HttpError(400, 'bad_email', 'Digite um e-mail válido (ou * para qualquer e-mail).');
    if (email === '*' && canCloud) throw new HttpError(400, 'bad_rule', 'O asterisco só vale para receber o código, nunca para enviar músicas.');
    const em = this.orm.em.fork();
    if (!canPair && !canCloud) {
      await em.nativeDelete(EmailRule, { email });
      return { ok: true, removed: true };
    }
    // a rule that already exists keeps its creation date
    await em.upsert(EmailRule, { email, canPair, canCloud, createdAt: Date.now() }, { onConflictFields: ['email'], onConflictMergeFields: ['canPair', 'canCloud'] });
    return { ok: true };
  }

  async deleteEmailRule(email: string) {
    const removed = await this.orm.em.fork().nativeDelete(EmailRule, { email: email.trim().toLowerCase() });
    if (!removed) throw new HttpError(404, 'not_found', 'Este e-mail não está na lista.');
    return { ok: true };
  }

  /** Disconnects a computer: its app has to pair again. */
  async revokeDevice(id: string) {
    const device = await this.orm.em.fork().findOne(Device, { id });
    if (!device) throw new HttpError(404, 'not_found', 'Computador não encontrado.');
    await this.agents.revoke(device);
    return { ok: true };
  }

  /** Takes a song off the cloud and blocks it: the computers do not send it again until it is unblocked. */
  async removeFromCloud(videoId: string) {
    await this.storage.delete(`cache/${videoId}`);
    await this.orm.em.fork().upsert(CloudBlocked, { videoId, blockedAt: Date.now() });
    return { ok: true };
  }

  async unblock(videoId: string) {
    const removed = await this.orm.em.fork().nativeDelete(CloudBlocked, { videoId });
    if (!removed) throw new HttpError(404, 'not_found', 'Esta música não estava bloqueada.');
    return { ok: true };
  }
}
