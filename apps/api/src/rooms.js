// Salas e fila de reprodução.
//
// Papéis: "TV" (o navegador que toca; dono da posição e do evento "terminou"), "controle" (celulares) e
// "anfitrião" (quem criou a sala: pula, pausa, reordena e remove de qualquer um). Os demais adicionam músicas e
// removem/ajustam as próprias. Comandos chegam por REST; o WebSocket só empurra o estado e recebe os eventos da TV.
//
// Estado único por processo (hub em memória). Com várias réplicas da API, o hub passaria a usar Redis pub/sub.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { clampOffset, clampPitch, nextPlayable, playOrder, swapTarget } from './queue-logic.js';
import { extractVideoId } from './youtube.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I/L: fácil de ditar e digitar
export const MAX_QUEUE = 100;
export const MAX_PER_CLIENT = 20;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60_000;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

export function generateCode(length = 4) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Conexões WebSocket por sala. */
export function createHub() {
  const rooms = new Map(); // code -> Set<conn>
  return {
    add(code, conn) {
      if (!rooms.has(code)) rooms.set(code, new Set());
      rooms.get(code).add(conn);
      return () => {
        rooms.get(code)?.delete(conn);
        if (!rooms.get(code)?.size) rooms.delete(code);
      };
    },
    count: (code, role) => [...(rooms.get(code) ?? [])].filter((c) => c.role === role).length,
    codes: () => [...rooms.keys()],
    /** `build(conn)` devolve o objeto a enviar para aquela conexão (ou null para pular). */
    broadcast(code, build) {
      for (const conn of rooms.get(code) ?? []) {
        const payload = build(conn);
        if (payload && conn.socket.readyState === 1) conn.socket.send(JSON.stringify(payload));
      }
    },
    /** Derruba conexões que não responderam ao ping anterior (TV desligada sem fechar o socket). */
    heartbeat() {
      for (const conns of rooms.values()) {
        for (const conn of conns) {
          if (conn.alive === false) {
            conn.socket.terminate();
            continue;
          }
          conn.alive = false;
          conn.socket.ping();
        }
      }
    },
  };
}

/** Estado enviado a UMA conexão: sem client_id de ninguém, com `mine`/`can_edit` por item. */
export function personalize(base, { clientId, isHost }) {
  return {
    ...base,
    me: { is_host: Boolean(isHost) },
    queue: base.queue.map(({ client_id: owner, ...item }) => ({
      ...item,
      mine: owner === clientId,
      can_edit: Boolean(isHost) || owner === clientId,
    })),
  };
}

export function createRoomService({
  db,
  songs,
  hub,
  now = Date.now,
  newCode = generateCode,
  newToken = () => randomBytes(16).toString('hex'),
}) {
  const positions = new Map(); // code -> {item_id, ms}  (efêmero: só a TV sabe, e reporta a cada poucos segundos)
  const lastKeys = new Map(); // code -> último estado difundido (sem a posição)
  const touched = new Map(); // code -> última vez que gravamos last_active_at
  const locks = new Map(); // code -> cauda da fila de operações da sala
  let timers = [];

  /** Serializa as operações de uma sala: evita duas "avançar a fila" ao mesmo tempo. */
  function withLock(code, fn) {
    const run = (locks.get(code) ?? Promise.resolve()).then(fn, fn);
    locks.set(code, run.catch(() => {}));
    return run;
  }

  function requireRoom(code) {
    const room = db.getRoom(normalizeCode(code));
    if (!room) throw new HttpError(404, 'room_not_found', 'Sala não encontrada.');
    return room;
  }

  function hostCheck(room, token) {
    if (!token) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(room.host_token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function requireHost(room, actor) {
    if (!hostCheck(room, actor.hostToken)) {
      throw new HttpError(403, 'host_only', 'Só o anfitrião da sala pode fazer isso.');
    }
  }

  function requireItem(room, itemId) {
    const item = db.getItem(Number(itemId));
    if (!item || item.room_code !== room.code || !['queued', 'playing'].includes(item.status)) {
      throw new HttpError(404, 'item_not_found', 'Música não encontrada na fila.');
    }
    return item;
  }

  function requireEditable(room, item, actor) {
    if (!(hostCheck(room, actor.hostToken) || item.client_id === actor.clientId)) {
      throw new HttpError(403, 'not_your_item', 'Você só pode alterar as suas músicas.');
    }
  }

  function touch(code) {
    const t = now();
    if (t - (touched.get(code) ?? 0) < TOUCH_EVERY_MS) return;
    touched.set(code, t);
    db.updateRoom(code, { last_active_at: t });
  }

  async function readySet(items) {
    const ids = [...new Set(items.map((i) => i.video_id))];
    const flags = await Promise.all(ids.map((id) => songs.isReady(id)));
    return new Set(ids.filter((_, i) => flags[i]));
  }

  /** Se nada está tocando, põe para tocar o próximo item PRONTO (itens ainda em processamento mantêm a posição). */
  async function tryAdvance(code) {
    const room = db.getRoom(code);
    if (!room || (room.current_item_id && room.playback !== 'idle')) return false;
    const queued = db.listActive(code).filter((i) => i.status === 'queued');
    const pick = nextPlayable(queued, await readySet(queued), { fair: Boolean(room.fair), lastClientId: room.last_client_id });
    if (!pick) {
      if (room.current_item_id || room.playback !== 'idle') db.updateRoom(code, { current_item_id: null, playback: 'idle' });
      return false;
    }
    db.transaction(() => {
      db.updateItem(pick.id, { status: 'playing', played_at: now() });
      db.touchPlayed(pick.video_id, now()); // base da limpeza do cache por uso (LRU)
      db.updateRoom(code, { current_item_id: pick.id, playback: 'playing', last_client_id: pick.client_id });
    });
    positions.delete(code);
    return true;
  }

  function finishCurrent(code, status) {
    const room = db.getRoom(code);
    if (!room?.current_item_id) return;
    db.transaction(() => {
      db.updateItem(room.current_item_id, { status });
      db.updateRoom(code, { current_item_id: null, playback: 'idle' });
    });
    positions.delete(code);
  }

  /** Estado base da sala (com o client_id de cada item; use `personalize` antes de enviar a alguém). */
  async function snapshot(code) {
    const room = requireRoom(code);
    // o que está tocando vem primeiro (com o rodízio justo ele pode ter posição maior que a de quem aguarda)
    const items = db.listActive(room.code).sort((a, b) => Number(b.status === 'playing') - Number(a.status === 'playing'));
    const ids = [...new Set(items.map((i) => i.video_id))];
    const described = new Map(await Promise.all(ids.map(async (id) => [id, await songs.describe(id)])));
    const position = positions.get(room.code);
    // quem toca a seguir: a mesma regra do avanço da fila (só músicas prontas; rodízio justo, se ligado)
    const ready = new Set(ids.filter((id) => described.get(id)?.media));
    const upNext = nextPlayable(items.filter((i) => i.status === 'queued'), ready, {
      fair: Boolean(room.fair),
      lastClientId: room.last_client_id,
    });
    const waiting = items.filter((i) => i.status === 'queued');
    return {
      code: room.code,
      fair: Boolean(room.fair),
      scoring: Boolean(room.scoring),
      scoreboard: db.listScored(room.code).map((r) => ({ id: r.id, name: r.added_by, title: r.title, score: r.score })),
      play_order: playOrder(waiting, { fair: Boolean(room.fair), lastClientId: room.last_client_id }).map((i) => i.id),
      playback: room.playback,
      current_item_id: room.current_item_id,
      next_item_id: upNext?.id ?? null,
      position_ms: position?.item_id === room.current_item_id ? position.ms : 0,
      tv_connected: hub.count(room.code, 'tv') > 0,
      queue: items.map((item) => {
        const song = described.get(item.video_id);
        return {
          id: item.id,
          video_id: item.video_id,
          title: song?.meta?.title ?? item.title,
          artist: song?.meta?.artist ?? item.artist,
          added_by: item.added_by,
          client_id: item.client_id,
          pitch: item.pitch,
          status: item.status,
          lyric_offset: db.getOffset(item.video_id),
          song: {
            status: song?.status ?? 'unknown',
            stage: song?.stage ?? null,
            error: song?.error ?? null,
            error_code: song?.error_code ?? null,
            retry: song?.retry ?? null,
            ready: Boolean(song?.media),
            duration: song?.meta?.duration ?? null,
            lyrics_source: song?.meta?.lyrics_source ?? null,
            key: song?.meta?.key ?? null,
            media: song?.media ?? null,
          },
        };
      }),
    };
  }

  const stateKey = (base) => JSON.stringify({ ...base, position_ms: 0 });

  function publishBase(code, base) {
    lastKeys.set(code, stateKey(base));
    hub.broadcast(code, (conn) => ({ type: 'state', state: personalize(base, conn) }));
  }

  async function publish(code) {
    publishBase(code, await snapshot(code));
  }

  async function stateFor(code, actor) {
    const room = requireRoom(code);
    return personalize(await snapshot(code), { clientId: actor.clientId, isHost: hostCheck(room, actor.hostToken) });
  }

  /** Aplica uma mutação sob o lock da sala, avança a fila se preciso, difunde e devolve o estado do solicitante. */
  function mutate(code, actor, fn) {
    const normalized = normalizeCode(code);
    return withLock(normalized, async () => {
      const room = requireRoom(normalized);
      const result = await fn(room);
      await tryAdvance(normalized);
      touch(normalized);
      await publish(normalized);
      return { ...(result ?? {}), state: await stateFor(normalized, actor) };
    });
  }

  return {
    createRoom() {
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = newCode();
        if (db.getRoom(code)) continue;
        const hostToken = newToken();
        db.createRoom(code, hostToken, now());
        return { code, host_token: hostToken };
      }
      throw new HttpError(503, 'no_room_code', 'Não consegui criar uma sala agora. Tente de novo.');
    },

    getState: (code, actor) => stateFor(normalizeCode(code), actor),

    add(code, params, actor) {
      return mutate(code, actor, async (room) => {
        const videoId = params.video_id ?? extractVideoId(params.url);
        if (!videoId) throw new HttpError(400, 'invalid_url', 'Link do YouTube inválido.');
        if (['text', 'file', 'align'].includes(params.lyrics?.source) && !params.lyrics.text?.trim()) {
          throw new HttpError(400, 'lyrics_text_required', 'Informe o texto da letra.');
        }
        // música ainda não processada: artista e nome são obrigatórios (a busca da letra e a fila dependem deles);
        // as já prontas (biblioteca) têm esses dados no meta.json
        const artist = params.artist?.trim();
        const title = params.title?.trim();
        if (!(await songs.isReady(videoId)) && !(artist && title)) {
          throw new HttpError(400, 'artist_title_required', 'Informe o artista e o nome da música.');
        }
        if (db.countQueued(room.code) >= MAX_QUEUE) throw new HttpError(409, 'queue_full', 'A fila está cheia.');
        if (db.countQueuedBy(room.code, actor.clientId) >= MAX_PER_CLIENT) {
          throw new HttpError(409, 'too_many', `Cada pessoa pode ter até ${MAX_PER_CLIENT} músicas na fila.`);
        }
        const song = await songs.request(videoId, { lyrics: params.lyrics, artist, title });
        const itemId = db.addItem({
          roomCode: room.code,
          videoId,
          title: params.display_title ?? song.song?.meta?.title ?? title ?? null,
          artist: artist ?? song.song?.meta?.artist ?? null,
          addedBy: (params.name ?? '').trim().slice(0, 30) || 'Alguém',
          clientId: actor.clientId,
          pitch: clampPitch(params.pitch ?? 0),
          now: now(),
        });
        return { item_id: itemId, cached: song.cached, deduped: song.deduped };
      });
    },

    remove(code, itemId, actor) {
      return mutate(code, actor, (room) => {
        const item = requireItem(room, itemId);
        requireEditable(room, item, actor);
        if (item.status === 'playing') finishCurrent(room.code, 'skipped');
        else db.deleteItem(item.id);
      });
    },

    /**
     * Troca de lugar com o vizinho. Descer ("ceder a vez": adiar a própria música em uma posição, ex.: foi ao banheiro)
     * o dono também pode; subir só o anfitrião, senão qualquer um furaria a fila.
     */
    move(code, itemId, direction, actor) {
      return mutate(code, actor, (room) => {
        const item = requireItem(room, itemId);
        if (direction === 'up') requireHost(room, actor);
        else requireEditable(room, item, actor);
        if (item.status !== 'queued') throw new HttpError(409, 'not_queued', 'Só dá para mover músicas que aguardam.');
        const queued = db.listActive(room.code).filter((i) => i.status === 'queued').map((i) => i.id);
        const target = swapTarget(queued, item.id, direction);
        if (target) db.swapPositions(item.id, target);
      });
    },

    setPitch(code, itemId, pitch, actor) {
      return mutate(code, actor, (room) => {
        const item = requireItem(room, itemId);
        requireEditable(room, item, actor);
        db.updateItem(item.id, { pitch: clampPitch(pitch) });
      });
    },

    skip(code, actor) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        finishCurrent(room.code, 'skipped');
      });
    },

    /**
     * Muda a posição da música que está tocando (só o anfitrião): `{ to }` = vai para esse ponto (segundos, a barra de
     * progresso arrastada); `{ seconds }` = avança ou volta esse tanto. Quem executa é a TV, dona da posição.
     */
    seek(code, { seconds, to }, actor) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        if (!room.current_item_id) return;
        const itemId = room.current_item_id;
        hub.broadcast(room.code, (conn) => (conn.role === 'tv' ? { type: 'seek', item_id: itemId, ...(to === undefined ? { seconds } : { to }) } : null));
      });
    },

    setPlayback(code, playing, actor) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        if (room.current_item_id) db.updateRoom(room.code, { playback: playing ? 'playing' : 'paused' });
      });
    },

    /** Ajustes da sala, só do anfitrião: `fair` (rodízio justo) e `scoring` (pontuação pelo microfone). */
    setSettings(code, settings, actor) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        const fields = {};
        if (typeof settings.fair === 'boolean') fields.fair = settings.fair ? 1 : 0;
        if (typeof settings.scoring === 'boolean') fields.scoring = settings.scoring ? 1 : 0;
        db.updateRoom(room.code, fields);
      });
    },

    /** Pontuação final enviada pela TV ao fim da música (só vale com a pontuação ligada e para o item que está tocando). */
    tvScore(code, itemId, score) {
      const room = db.getRoom(normalizeCode(code));
      const item = db.getItem(itemId);
      if (!room?.scoring || !item || item.room_code !== room.code || item.status !== 'playing') return;
      if (!Number.isInteger(score) || score < 0 || score > 100) return;
      db.updateItem(item.id, { score });
      this.tick().catch(() => {});
    },

    setOffset(code, videoId, offset, actor) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        db.setOffset(videoId, clampOffset(offset));
      });
    },

    /** Evento da TV: a música terminou (ignorado se não for a atual: idempotente). */
    tvEnded(code, itemId) {
      const normalized = normalizeCode(code);
      return withLock(normalized, async () => {
        const room = db.getRoom(normalized);
        if (!room || room.current_item_id !== itemId) return;
        finishCurrent(normalized, 'done');
        await tryAdvance(normalized);
        await publish(normalized);
      });
    },

    /** Evento da TV: posição atual (ms). Só controles recebem; não passa pelo banco. */
    tvPosition(code, itemId, ms) {
      const normalized = normalizeCode(code);
      positions.set(normalized, { item_id: itemId, ms });
      touch(normalized);
      hub.broadcast(normalized, (conn) => (conn.role === 'controller' ? { type: 'position', item_id: itemId, ms } : null));
    },

    /** Registra uma conexão WebSocket; devolve `leave` para chamar ao fechar. Lança 404 se a sala não existe. */
    connect(code, { socket, role, clientId, hostToken }) {
      const room = requireRoom(code);
      const conn = {
        socket,
        role: role === 'tv' ? 'tv' : 'controller',
        clientId: clientId ?? '',
        isHost: hostCheck(room, hostToken),
        alive: true,
      };
      const remove = hub.add(room.code, conn);
      publish(room.code).catch(() => {});
      return {
        conn,
        leave() {
          remove();
          publish(room.code).catch(() => {});
        },
      };
    },

    /** Mensagem recebida por WebSocket (só a TV envia comandos). */
    onMessage(code, conn, raw) {
      if (conn.role !== 'tv') return;
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Number.isInteger(message?.item_id)) return;
      if (message.type === 'score') this.tvScore(code, message.item_id, message.score);
      else if (message.type === 'ended') this.tvEnded(code, message.item_id).catch(() => {});
      else if (message.type === 'position' && Number.isFinite(message.ms)) this.tvPosition(code, message.item_id, message.ms);
    },

    /** Passo periódico: avança a fila quando uma música fica pronta e difunde mudanças (progresso do processamento). */
    async tick() {
      for (const code of hub.codes()) {
        await withLock(code, async () => {
          try {
            const advanced = await tryAdvance(code);
            const base = await snapshot(code);
            if (advanced || stateKey(base) !== lastKeys.get(code)) publishBase(code, base);
          } catch {
            // sala removida ou storage indisponível: tenta de novo no próximo passo
          }
        });
      }
    },

    start({ tickMs = 1500 } = {}) {
      db.deleteInactiveRooms(now() - ROOM_TTL_MS);
      timers = [
        setInterval(() => this.tick(), tickMs),
        setInterval(() => hub.heartbeat(), 30_000),
        setInterval(() => db.deleteInactiveRooms(now() - ROOM_TTL_MS), 60 * 60 * 1000),
      ];
      for (const timer of timers) timer.unref();
    },

    stop() {
      for (const timer of timers) clearInterval(timer);
      timers = [];
    },
  };
}
