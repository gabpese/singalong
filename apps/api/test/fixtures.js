// What the tests put straight into the database and read back, through MikroORM, the way the API does. `openDatabase()` opens a
// database of a test's own; `fixtures(orm)` works on any MikroORM instance, `app.orm` included.
import { MikroORM } from '@mikro-orm/core';
import { openConnection } from '../dist/database/connection.js';
import { Device, PairCode, PlayLog, QueueItem, Room, Session, SongSettings } from '../dist/database/entities.js';
import { ormOptions } from '../dist/database/orm.js';

/** A database for one test, in a file or in memory, built by the migrations unless `migrate: false`. */
export async function openDatabase(path = ':memory:', { migrate = true } = {}) {
  const connection = openConnection(path);
  const orm = await MikroORM.init(ormOptions(connection));
  if (migrate) await orm.migrator.up();
  return {
    connection,
    orm,
    close: async () => {
      await orm.close();
      connection.close();
    },
  };
}

export function fixtures(orm) {
  const em = () => orm.em.fork();
  return {
    createDevice: ({ id, name, tokenHash, now, email = null }) => em().insert(Device, { id, name, tokenHash, createdAt: now, lastSeen: now, email }),
    getDevice: (id) => em().findOne(Device, { id }),
    /** Saves a pairing code (one already saved is replaced). */
    savePairCode: (codeHash, expiresAt, email = null) => em().upsert(PairCode, { codeHash, expiresAt, email }),
    getSession: (id) => em().findOne(Session, { id }),
    /** The Session's last sign of life (an ended Session stays as it is). */
    touchSession: (id, lastSeen) => em().nativeUpdate(Session, { id, endedAt: null }, { lastSeen }),
    createRoom: (code, hostToken, now) => em().insert(Room, { code, hostToken, createdAt: now, lastActiveAt: now }),
    updateRoom: (code, fields) => em().nativeUpdate(Room, { code }, fields),
    /** A play in an owner's history: `{ device, sessionId, videoId, singer, singerKey, outcome, endedAt, … }`. */
    logPlay: (play) => em().insert(PlayLog, play),
    /** A song at the end of the Room's Queue; returns its id. */
    async addItem({ room, videoId, addedBy, clientId, now }) {
      const last = await em().findOne(QueueItem, { room }, { orderBy: { position: 'desc' } });
      return em().insert(QueueItem, { room, videoId, addedBy, clientId, position: (last?.position ?? 0) + 1, createdAt: now });
    },
    updateItem: (id, fields) => em().nativeUpdate(QueueItem, { id }, fields),
    /** Records when the song last played, as the Rooms do when it starts. */
    touchPlayed: (videoId, lastPlayedAt) =>
      em().upsert(SongSettings, { videoId, lastPlayedAt }, { onConflictFields: ['videoId'], onConflictMergeFields: ['lastPlayedAt'] }),
    /** Sets the song's lyrics offset, as the Host does. */
    setOffset: (videoId, lyricOffset) =>
      em().upsert(SongSettings, { videoId, lyricOffset }, { onConflictFields: ['videoId'], onConflictMergeFields: ['lyricOffset'] }),
    songSettings: (videoId) => em().findOne(SongSettings, { videoId }),
  };
}
