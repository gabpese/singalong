import { randomBytes, randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/core';
import type { JobStore } from '../app.ts';
import { AgentSong, CloudBlocked, Device, EmailRule, PairCode, Session } from '../database/entities.ts';
import { HttpError } from '../http-error.ts';
import { generateCode } from '../rooms/rooms.ts';
import { createSerializer } from '../serial.ts';
import { parseVersion } from '../version.ts';
import {
  checkLibraryEntry,
  clean,
  type LibraryFiles,
  MAX_LIBRARY_BATCH,
  MAX_NAME,
  normalizeMediaBase,
  ONLINE_MS,
  PAIR_CODE_LENGTH,
  PAIR_TTL_MS,
  SESSION_TTL_MS,
  sha256,
} from './agents.ts';

/** What the agent service needs of a device: the routes pass the authenticated Device; some callers only have its id. */
export type DeviceRef = { id: string; email?: string | null };

export interface AgentServiceOptions {
  /** E-mails (lowercase) whose computers send their songs to the cloud by themselves (ENABLED_TO_SEND_TO_CLOUD). */
  cloudEmails?: string[];
  now?: () => number;
}

/**
 * The agents' devices, pairing and Sessions, on MikroORM: each call gets its own EntityManager. app.ts builds it before Nest,
 * because the Rooms and the songs use it too.
 */
export class AgentService {
  private readonly cloudEmails: string[];
  private readonly now: () => number;
  /** One device's Session changes run one at a time: two "start session" at once must not leave two active Sessions. */
  private readonly perDevice = createSerializer();

  constructor(
    private readonly orm: MikroORM,
    private readonly jobs: JobStore,
    { cloudEmails = [], now = Date.now }: AgentServiceOptions = {},
  ) {
    this.cloudEmails = cloudEmails;
    this.now = now;
  }

  private em() {
    return this.orm.em.fork();
  }

  private online(session: Session | null): boolean {
    return Boolean(session) && !session!.endedAt && this.now() - session!.lastSeen <= ONLINE_MS;
  }

  private activeSessionIn(em: ReturnType<typeof this.em>, deviceId: string) {
    return em.findOne(Session, { device: deviceId, endedAt: null }, { orderBy: { createdAt: 'desc' } });
  }

  // --- pairing ---

  /** A one-time pairing code (whoever calls has already proven to be the server's administrator, or asked by e-mail). */
  async startPairing(email: string | null = null) {
    const code = generateCode(PAIR_CODE_LENGTH);
    const em = this.em();
    await em.nativeDelete(PairCode, { expiresAt: { $lte: this.now() } }); // expired codes do not pile up
    await em.upsert(PairCode, { codeHash: sha256(code), expiresAt: this.now() + PAIR_TTL_MS, email });
    return { code, expires_in: PAIR_TTL_MS / 1000 };
  }

  /** Trades the code for a device token (shown only once). */
  async completePairing(code: string, name?: string) {
    const em = this.em();
    // one statement deletes and reads the code: two requests with the same code can never both get it
    const used = (await em.getConnection().execute(
      'DELETE FROM pair_codes WHERE code_hash = ? RETURNING expires_at, email',
      [sha256(String(code ?? '').replace(/\s+/g, '').toUpperCase())],
      'get',
    )) as { expires_at: number; email: string | null } | undefined;
    if (!used || used.expires_at <= this.now()) throw new HttpError(400, 'invalid_pair_code', 'Código de pareamento inválido ou vencido.');
    const token = `sga_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    await em.insert(Device, { id, name: clean(name, 60) || 'Meu computador', tokenHash: sha256(token), createdAt: this.now(), lastSeen: this.now(), email: used.email ?? null });
    return { device_id: id, token };
  }

  /** Does this computer send its songs to the cloud? Only if it paired with an e-mail from ENABLED_TO_SEND_TO_CLOUD or the admin page. */
  async canUploadToCloud(device: DeviceRef | null | undefined): Promise<boolean> {
    const email = String(device?.email ?? '').toLowerCase();
    if (!email) return false;
    if (this.cloudEmails.includes(email)) return true;
    return Boolean((await this.em().findOne(EmailRule, { email }))?.canCloud); // the .env and the admin page add up
  }

  /** May this e-mail get a pairing code? ('*' = anyone; the .env and the admin page add up.) */
  async canPairByEmail(email: string, envList: string[] = []): Promise<boolean> {
    const typed = String(email ?? '').toLowerCase();
    if (envList.includes('*') || envList.includes(typed)) return true;
    const rules = await this.em().find(EmailRule, { email: { $in: ['*', typed] } });
    return rules.some((rule) => rule.canPair);
  }

  async isSongBlocked(videoId: string): Promise<boolean> {
    return (await this.em().count(CloudBlocked, { videoId })) > 0;
  }

  /** Has the "code by e-mail" feature anyone authorized (in the .env or on the admin page)? */
  async hasPairRules(envList: string[] = []): Promise<boolean> {
    return envList.length > 0 || (await this.em().count(EmailRule, { canPair: true })) > 0;
  }

  // --- devices ---

  /** The device that owns the token (or null if the token does not exist or was revoked); it also counts as a sign of life. */
  async authenticate(token: string): Promise<Device | null> {
    const value = String(token ?? '');
    if (!value) return null;
    const em = this.em();
    const device = await em.findOne(Device, { tokenHash: sha256(value), revokedAt: null });
    if (!device) return null;
    await em.nativeUpdate(Device, { id: device.id }, { lastSeen: this.now() });
    return device;
  }

  /** Revokes the device and ends its Session. */
  revoke(device: DeviceRef): Promise<void> {
    return this.perDevice(device.id, async () => {
      const em = this.em();
      const session = await this.activeSessionIn(em, device.id);
      if (session) await this.endSession(session);
      await em.nativeUpdate(Device, { id: device.id, revokedAt: null }, { revokedAt: this.now() });
    });
  }

  /** The app version the computer reported (only values that are versions; the admin page shows who is out of date). */
  async recordVersion(device: DeviceRef, version: string) {
    if (!parseVersion(version)) return;
    const value = String(version).trim().slice(0, 40);
    await this.em().nativeUpdate(Device, { id: device.id, $or: [{ appVersion: null }, { appVersion: { $ne: value } }] }, { appVersion: value });
  }

  // --- Sessions ---

  /**
   * Starts the device's Session. `resumeId` resumes the earlier Session (the app restarted): its Rooms and requests go on.
   * Without it, any active Session of the device is ended (and its pending requests abandoned).
   */
  async startSession(device: DeviceRef, displayName: string, { resumeId, mediaBase }: { resumeId?: string; mediaBase?: string } = {}): Promise<Session> {
    const name = clean(displayName, MAX_NAME);
    if (!name) throw new HttpError(400, 'display_name_required', 'Escolha um apelido para a sessão.');
    const media = normalizeMediaBase(mediaBase); // checked before touching any Session
    return this.perDevice(device.id, async () => {
      const em = this.em();
      const current = await this.activeSessionIn(em, device.id);
      if (current && resumeId && current.id === resumeId) {
        await em.nativeUpdate(Session, { id: current.id }, {
          displayName: name,
          lastSeen: this.now(),
          ...(mediaBase === undefined ? {} : { mediaBase: media }),
        });
        return this.em().findOneOrFail(Session, { id: current.id });
      }
      if (current) await this.endSession(current);
      const id = randomUUID();
      await em.insert(Session, { id, device: device.id, displayName: name, createdAt: this.now(), lastSeen: this.now(), mediaBase: media });
      return this.em().findOneOrFail(Session, { id });
    });
  }

  /** The agent changed its media address (it restarted the local server): the Session points to the new one. */
  async setMediaBase(session: { id: string }, mediaBase: unknown) {
    await this.em().nativeUpdate(Session, { id: session.id }, { mediaBase: normalizeMediaBase(mediaBase) });
  }

  /** The device's Session; 404 when it does not exist or belongs to another device (it does not reveal that it exists). */
  async ownSession(device: DeviceRef, sessionId: string): Promise<Session> {
    const session = await this.em().findOne(Session, { id: String(sessionId) });
    if (!session || session.device.id !== device.id) throw new HttpError(404, 'session_not_found', 'Sessão não encontrada.');
    return session;
  }

  /** Ends the Session: the requests nobody will serve fail with a clear message. */
  async endSession(session: { id: string }) {
    const ended = await this.em().nativeUpdate(Session, { id: session.id, endedAt: null }, { endedAt: this.now() });
    if (ended) await this.jobs.abandonSession?.(session.id);
  }

  /** The agent's sign of life: the device and its active Session are "online". Returns the active Session (or null). */
  async touch(device: DeviceRef): Promise<Session | null> {
    const em = this.em();
    await em.nativeUpdate(Device, { id: device.id }, { lastSeen: this.now() });
    const session = await this.activeSessionIn(em, device.id);
    if (session) await em.nativeUpdate(Session, { id: session.id, endedAt: null }, { lastSeen: this.now() });
    return session;
  }

  /** The device's active Session (or null). */
  activeSession(device: DeviceRef): Promise<Session | null> {
    return this.activeSessionIn(this.em(), device.id);
  }

  /** Is the Session's owner connected now? */
  async isOnline(sessionId: string): Promise<boolean> {
    return this.online(await this.em().findOne(Session, { id: sessionId }));
  }

  /** What the Rooms show about the owner: only the nickname and whether they are online. */
  async ownerOf(sessionId: string): Promise<{ nickname: string; online: boolean } | null> {
    const session = await this.em().findOne(Session, { id: sessionId });
    return session ? { nickname: session.displayName, online: this.online(session) } : null;
  }

  /** Ends the Sessions that went without a signal for too long. Returns how many. */
  async sweep(): Promise<number> {
    const stale = await this.em().find(Session, { endedAt: null, lastSeen: { $lt: this.now() - SESSION_TTL_MS } });
    for (const session of stale) await this.endSession(session);
    return stale.length;
  }

  // --- the owner's catalog (local storage) ---

  /**
   * The Session's local catalog: whose it is (the owning device) and where the browser fetches the media. null when the Session
   * has no local media server (the media is in the server's storage).
   */
  async libraryOfSession(sessionId: string | null | undefined): Promise<{ deviceId: string; mediaBase: string } | null> {
    const session = sessionId ? await this.em().findOne(Session, { id: sessionId }) : null;
    return session?.mediaBase ? { deviceId: session.device.id, mediaBase: session.mediaBase } : null;
  }

  /** A song in the device's catalog: its meta.json and which files exist, or null. */
  async librarySong(deviceId: string, videoId: string): Promise<{ meta: Record<string, unknown>; files: LibraryFiles } | null> {
    const row = await this.em().findOne(AgentSong, { device: deviceId, videoId });
    return row ? { meta: JSON.parse(row.meta), files: JSON.parse(row.files) } : null;
  }

  /** The songs in the device's catalog (their meta.json). */
  async libraryList(deviceId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.em().find(AgentSong, { device: deviceId }, { orderBy: { videoId: 'asc' } });
    return rows.map((row) => JSON.parse(row.meta));
  }

  /** Publishes songs in the device's catalog (up to MAX_LIBRARY_BATCH at a time). */
  async publishLibrary(device: DeviceRef, entries: unknown): Promise<number> {
    if (!Array.isArray(entries) || entries.length > MAX_LIBRARY_BATCH) {
      throw new HttpError(400, 'invalid_library_batch', `Envie até ${MAX_LIBRARY_BATCH} músicas por vez.`);
    }
    const checked = entries.map(checkLibraryEntry);
    const updatedAt = this.now();
    if (checked.length) {
      await this.em().upsertMany(AgentSong, checked.map(({ videoId, meta, files }) => ({ device: device.id, videoId, meta: JSON.stringify(meta), files: JSON.stringify(files), updatedAt })));
    }
    return entries.length;
  }

  /** Takes a song off the catalog (the owner deleted the file). */
  async unpublish(device: DeviceRef, videoId: string): Promise<boolean> {
    return (await this.em().nativeDelete(AgentSong, { device: device.id, videoId: String(videoId) })) > 0;
  }
}
