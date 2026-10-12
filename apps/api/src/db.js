// Persistência (SQLite embutido do Node): salas, fila e ajustes por música.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code            TEXT PRIMARY KEY,
  host_token      TEXT NOT NULL,
  fair            INTEGER NOT NULL DEFAULT 0,
  scoring         INTEGER NOT NULL DEFAULT 0,       -- pontuação pelo microfone (decidida pelo anfitrião)
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
  backing     INTEGER NOT NULL DEFAULT 0,         -- nível das vozes de apoio (0..100 %)
  position    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',     -- queued | playing | done | skipped
  created_at  INTEGER NOT NULL,
  played_at   INTEGER,
  score       INTEGER                             -- pontuação final (0..100), quando a sala pontua
);
CREATE INDEX IF NOT EXISTS idx_items_room ON queue_items (room_code, status, position);
CREATE TABLE IF NOT EXISTS song_settings (
  video_id     TEXT PRIMARY KEY,
  lyric_offset REAL NOT NULL DEFAULT 0
);
-- Agente local (o app instalado no computador do dono): dispositivos pareados, códigos de pareamento e sessões.
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,                  -- só o SHA-256 do token: o token em si nunca fica guardado
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  revoked_at  INTEGER
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash   TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,                        -- o apelido que os convidados veem (nunca a conta do YouTube)
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions (device_id, ended_at);
-- Regras por e-mail, geridas na página do administrador: quem pode receber o código de pareamento e quem envia músicas para a nuvem.
-- ('*' em can_pair = qualquer e-mail). Somam-se às listas do .env (PAIR_ALLOWED_EMAILS e ENABLED_TO_SEND_TO_CLOUD).
CREATE TABLE IF NOT EXISTS email_rules (
  email       TEXT PRIMARY KEY,
  can_pair    INTEGER NOT NULL DEFAULT 0,
  can_cloud   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
-- Músicas que o administrador tirou da nuvem: os computadores não as enviam de novo (até ele liberar).
CREATE TABLE IF NOT EXISTS cloud_blocked (
  video_id    TEXT PRIMARY KEY,
  blocked_at  INTEGER NOT NULL
);
-- Catálogo do dono: as músicas que estão NO COMPUTADOR dele (armazenamento local). A nuvem não vê os arquivos; sabe só o
-- que o agente publica (o meta.json e quais arquivos existem) e onde o navegador os busca (sessions.media_base).
CREATE TABLE IF NOT EXISTS agent_songs (
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL,
  meta        TEXT NOT NULL,                         -- o meta.json da música (JSON)
  files       TEXT NOT NULL,                         -- { instrumental, lyrics, melody, backing, exports: [tons] }
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, video_id)
);
`;

const ROOM_FIELDS = new Set(['fair', 'scoring', 'current_item_id', 'playback', 'last_client_id', 'last_active_at']);
const ITEM_FIELDS = new Set(['pitch', 'backing', 'position', 'status', 'played_at', 'score', 'title', 'artist']);

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // bancos criados antes da limpeza do cache não têm last_played_at
  if (!db.prepare('PRAGMA table_info(song_settings)').all().some((c) => c.name === 'last_played_at')) {
    db.exec('ALTER TABLE song_settings ADD COLUMN last_played_at INTEGER');
  }

  // bancos criados antes da pontuação não têm estas colunas
  const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!hasColumn('rooms', 'scoring')) db.exec('ALTER TABLE rooms ADD COLUMN scoring INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('queue_items', 'score')) db.exec('ALTER TABLE queue_items ADD COLUMN score INTEGER');
  if (!hasColumn('queue_items', 'backing')) db.exec('ALTER TABLE queue_items ADD COLUMN backing INTEGER NOT NULL DEFAULT 0');
  // bancos criados antes do agente local não têm a sessão da sala (nula = sala sem dono de sessão: o worker clássico)
  if (!hasColumn('rooms', 'session_id')) db.exec('ALTER TABLE rooms ADD COLUMN session_id TEXT REFERENCES sessions(id)');
  // onde o navegador busca a mídia da sessão (o servidor local de mídia do agente); nulo = a mídia está no armazenamento do servidor
  if (!hasColumn('sessions', 'media_base')) db.exec('ALTER TABLE sessions ADD COLUMN media_base TEXT');
  // o e-mail com que o computador foi pareado (pelo código enviado por e-mail): é ele que decide quem pode enviar músicas para a nuvem
  if (!hasColumn('devices', 'email')) db.exec('ALTER TABLE devices ADD COLUMN email TEXT');
  if (!hasColumn('pair_codes', 'email')) db.exec('ALTER TABLE pair_codes ADD COLUMN email TEXT');

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
    createRoom: (code, hostToken, now, sessionId = null) =>
      run('INSERT INTO rooms (code, host_token, created_at, last_active_at, session_id) VALUES (?, ?, ?, ?, ?)', code, hostToken, now, now, sessionId),
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
    /** Placar da sala: as maiores pontuações (nome, música, nota). */
    listScored: (roomCode, limit = 10) =>
      all('SELECT id, added_by, title, score FROM queue_items WHERE room_code = ? AND score IS NOT NULL ORDER BY score DESC, id LIMIT ?', roomCode, limit),
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

    // --- agente local: dispositivos, pareamento e sessões ---
    createDevice: ({ id, name, tokenHash, now, email = null }) =>
      run('INSERT INTO devices (id, name, token_hash, created_at, last_seen, email) VALUES (?, ?, ?, ?, ?, ?)', id, name, tokenHash, now, now, email),
    getDeviceByTokenHash: (tokenHash) => one('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL', tokenHash),
    getDevice: (id) => one('SELECT * FROM devices WHERE id = ?', id),
    touchDevice: (id, now) => run('UPDATE devices SET last_seen = ? WHERE id = ?', now, id),
    revokeDevice: (id, now) => run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, id).changes > 0,

    savePairCode: (codeHash, expiresAt, now, email = null) =>
      transaction(() => {
        run('DELETE FROM pair_codes WHERE expires_at <= ?', now); // não acumula códigos vencidos
        run('INSERT OR REPLACE INTO pair_codes (code_hash, expires_at, email) VALUES (?, ?, ?)', codeHash, expiresAt, email);
      }),
    /** Gasta o código (uso único): { email } (o e-mail a que foi enviado, se houve) só se existia e não tinha vencido; senão null. */
    consumePairCode: (codeHash, now) =>
      transaction(() => {
        const row = one('SELECT expires_at, email FROM pair_codes WHERE code_hash = ?', codeHash);
        run('DELETE FROM pair_codes WHERE code_hash = ?', codeHash);
        return row && row.expires_at > now ? { email: row.email ?? null } : null;
      }),

    createSession: ({ id, deviceId, displayName, now }) =>
      run('INSERT INTO sessions (id, device_id, display_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', id, deviceId, displayName, now, now),
    getSession: (id) => one('SELECT * FROM sessions WHERE id = ?', id),
    activeSessionOf: (deviceId) => one('SELECT * FROM sessions WHERE device_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1', deviceId),
    touchSession: (id, now) => run('UPDATE sessions SET last_seen = ? WHERE id = ? AND ended_at IS NULL', now, id),
    renameSession: (id, displayName) => run('UPDATE sessions SET display_name = ? WHERE id = ?', displayName, id),
    setSessionMedia: (id, mediaBase) => run('UPDATE sessions SET media_base = ? WHERE id = ?', mediaBase, id),

    /** Publica (ou atualiza) músicas do catálogo do dispositivo: `entries` = [{ videoId, meta, files }]. */
    upsertAgentSongs: (deviceId, entries, now) =>
      transaction(() => {
        for (const { videoId, meta, files } of entries) {
          run(
            `INSERT INTO agent_songs (device_id, video_id, meta, files, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(device_id, video_id) DO UPDATE SET meta = excluded.meta, files = excluded.files, updated_at = excluded.updated_at`,
            deviceId, videoId, JSON.stringify(meta), JSON.stringify(files), now,
          );
        }
      }),
    getAgentSong: (deviceId, videoId) => one('SELECT * FROM agent_songs WHERE device_id = ? AND video_id = ?', deviceId, videoId),
    // --- administração (página em ADMIN_PATH) ---
    listEmailRules: () => all('SELECT email, can_pair, can_cloud, created_at FROM email_rules ORDER BY email'),
    getEmailRule: (email) => one('SELECT email, can_pair, can_cloud FROM email_rules WHERE email = ?', email),
    upsertEmailRule: (email, canPair, canCloud, now) =>
      run(
        `INSERT INTO email_rules (email, can_pair, can_cloud, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET can_pair = excluded.can_pair, can_cloud = excluded.can_cloud`,
        email, canPair ? 1 : 0, canCloud ? 1 : 0, now,
      ),
    deleteEmailRule: (email) => run('DELETE FROM email_rules WHERE email = ?', email).changes > 0,
    hasPairRules: () => one('SELECT 1 AS n FROM email_rules WHERE can_pair = 1 LIMIT 1') !== null,
    listDevices: () => all('SELECT id, name, email, created_at, last_seen, revoked_at FROM devices ORDER BY created_at DESC'),
    blockSong: (videoId, now) => run('INSERT OR REPLACE INTO cloud_blocked (video_id, blocked_at) VALUES (?, ?)', videoId, now),
    unblockSong: (videoId) => run('DELETE FROM cloud_blocked WHERE video_id = ?', videoId).changes > 0,
    isSongBlocked: (videoId) => one('SELECT 1 AS n FROM cloud_blocked WHERE video_id = ?', videoId) !== null,
    listBlockedSongs: () => all('SELECT video_id, blocked_at FROM cloud_blocked ORDER BY blocked_at DESC'),

    listAgentSongs: (deviceId) => all('SELECT * FROM agent_songs WHERE device_id = ? ORDER BY video_id', deviceId),
    deleteAgentSong: (deviceId, videoId) => run('DELETE FROM agent_songs WHERE device_id = ? AND video_id = ?', deviceId, videoId).changes > 0,
    /** Encerra a sessão e devolve true se ela estava ativa. */
    endSession: (id, now) => run('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', now, id).changes > 0,
    /** Sessões ativas sem sinal desde `before` (o app fechou sem avisar). */
    listStaleSessions: (before) => all('SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen < ?', before),

    // --- ajustes por música (valem em qualquer sala) ---
    ping: () => one('SELECT 1 AS ok').ok === 1,
    /** Marca que a música foi (ou vai ser) tocada agora: a limpeza do cache apaga primeiro as mais antigas. */
    touchPlayed: (videoId, now) =>
      run(
        `INSERT INTO song_settings (video_id, last_played_at) VALUES (?, ?)
         ON CONFLICT(video_id) DO UPDATE SET last_played_at = excluded.last_played_at`,
        videoId, now,
      ),
    lastPlayed: (videoId) => one('SELECT last_played_at FROM song_settings WHERE video_id = ?', videoId)?.last_played_at ?? null,
    /** Músicas em uso (tocando ou na fila de alguma sala): nunca entram na limpeza. */
    activeVideoIds: () => new Set(all("SELECT DISTINCT video_id FROM queue_items WHERE status IN ('queued', 'playing')").map((r) => r.video_id)),
    getOffset: (videoId) => one('SELECT lyric_offset FROM song_settings WHERE video_id = ?', videoId)?.lyric_offset ?? 0,
    setOffset: (videoId, offset) =>
      run(
        `INSERT INTO song_settings (video_id, lyric_offset) VALUES (?, ?)
         ON CONFLICT(video_id) DO UPDATE SET lyric_offset = excluded.lyric_offset`,
        videoId, offset,
      ),
  };
}
