// Persistência (SQLite embutido do Node): salas, fila e ajustes por música.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code            TEXT PRIMARY KEY,
  host_token      TEXT NOT NULL,
  fair            INTEGER NOT NULL DEFAULT 0,
  current_item_id INTEGER,
  playback        TEXT NOT NULL DEFAULT 'idle',   -- idle | playing | paused
  last_client_id  TEXT,                           -- quem cantou por último (rodízio justo)
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  video_id    TEXT NOT NULL,
  title       TEXT,
  artist      TEXT,
  added_by    TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  pitch       INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',     -- queued | playing | done | skipped
  created_at  INTEGER NOT NULL,
  played_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_room ON queue_items (room_code, status, position);
CREATE TABLE IF NOT EXISTS song_settings (
  video_id     TEXT PRIMARY KEY,
  lyric_offset REAL NOT NULL DEFAULT 0
);
`;

const ROOM_FIELDS = new Set(['fair', 'current_item_id', 'playback', 'last_client_id', 'last_active_at']);
const ITEM_FIELDS = new Set(['pitch', 'position', 'status', 'played_at', 'title', 'artist']);

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const one = (sql, ...params) => db.prepare(sql).get(...params) ?? null;
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  /** UPDATE com colunas permitidas (nunca interpola valores vindos de fora no SQL). */
  function update(table, allowed, keyColumn, key, fields) {
    const entries = Object.entries(fields).filter(([name]) => allowed.has(name));
    if (!entries.length) return;
    const sets = entries.map(([name]) => `${name} = ?`).join(', ');
    run(`UPDATE ${table} SET ${sets} WHERE ${keyColumn} = ?`, ...entries.map(([, value]) => value), key);
  }

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    transaction,
    close: () => db.close(),

    // --- salas ---
    createRoom: (code, hostToken, now) =>
      run('INSERT INTO rooms (code, host_token, created_at, last_active_at) VALUES (?, ?, ?, ?)', code, hostToken, now, now),
    getRoom: (code) => one('SELECT * FROM rooms WHERE code = ?', code),
    listRoomCodes: () => all('SELECT code FROM rooms').map((r) => r.code),
    updateRoom: (code, fields) => update('rooms', ROOM_FIELDS, 'code', code, fields),
    deleteInactiveRooms: (before) => run('DELETE FROM rooms WHERE last_active_at < ?', before).changes,

    // --- fila ---
    addItem: ({ roomCode, videoId, title, artist, addedBy, clientId, pitch, now }) =>
      transaction(() => {
        const { next } = one('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM queue_items WHERE room_code = ?', roomCode);
        const result = run(
          `INSERT INTO queue_items (room_code, video_id, title, artist, added_by, client_id, pitch, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          roomCode, videoId, title ?? null, artist ?? null, addedBy, clientId, pitch, next, now,
        );
        return Number(result.lastInsertRowid);
      }),
    getItem: (id) => one('SELECT * FROM queue_items WHERE id = ?', id),
    /** Itens ativos da sala: o que está tocando e os que aguardam, na ordem da fila. */
    listActive: (roomCode) =>
      all("SELECT * FROM queue_items WHERE room_code = ? AND status IN ('queued', 'playing') ORDER BY position", roomCode),
    countQueuedBy: (roomCode, clientId) =>
      one("SELECT COUNT(*) AS n FROM queue_items WHERE room_code = ? AND client_id = ? AND status = 'queued'", roomCode, clientId).n,
    countQueued: (roomCode) => one("SELECT COUNT(*) AS n FROM queue_items WHERE room_code = ? AND status = 'queued'", roomCode).n,
    updateItem: (id, fields) => update('queue_items', ITEM_FIELDS, 'id', id, fields),
    deleteItem: (id) => run('DELETE FROM queue_items WHERE id = ?', id),
    swapPositions: (idA, idB) =>
      transaction(() => {
        const a = one('SELECT position FROM queue_items WHERE id = ?', idA);
        const b = one('SELECT position FROM queue_items WHERE id = ?', idB);
        run('UPDATE queue_items SET position = ? WHERE id = ?', b.position, idA);
        run('UPDATE queue_items SET position = ? WHERE id = ?', a.position, idB);
      }),

    // --- ajustes por música (valem em qualquer sala) ---
    getOffset: (videoId) => one('SELECT lyric_offset FROM song_settings WHERE video_id = ?', videoId)?.lyric_offset ?? 0,
    setOffset: (videoId, offset) =>
      run(
        `INSERT INTO song_settings (video_id, lyric_offset) VALUES (?, ?)
         ON CONFLICT(video_id) DO UPDATE SET lyric_offset = excluded.lyric_offset`,
        videoId, offset,
      ),
  };
}
