// Salas e fila de reprodução.
//
// Papéis: "TV" (o navegador que toca; dono da posição e do evento "terminou"), "controle" (celulares) e
// "anfitrião" (quem criou a sala: pula, pausa, reordena e remove de qualquer um). Os demais adicionam músicas e
// removem/ajustam as próprias. Comandos chegam por REST; o WebSocket só empurra o estado e recebe os eventos da TV.
//
// Estado único por processo (hub em memória). Com várias réplicas da API, o hub passaria a usar Redis pub/sub.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cleanParts, clampBacking, clampGuide, clampOffset, clampPitch, nextPlayable, playOrder, swapTarget } from './queue-logic.js';
import { createBucket, REACTION_KINDS } from './reactions.js';
import { createSerializer } from './serial.js';
import { extractVideoId } from './youtube.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I/L: fácil de ditar e digitar
export const MAX_QUEUE = 100;
export const MAX_PER_CLIENT = 20;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const PLAY_LOG_TTL_MS = 400 * 24 * 60 * 60 * 1000; // o histórico das músicas fica por mais de um ano
const TOUCH_EVERY_MS = 60_000;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Identificação de uma pessoa NA SALA para os convites: um resumo do client_id (que nunca sai do servidor) que não dá para desfazer. */
export const pidOf = (clientId) => createHash('sha256').update(`pessoa:${clientId}`).digest('hex').slice(0, 10);

/** O nome que a pessoa digitou (ou "Alguém"), no tamanho que a fila aceita. */
export const cleanName = (name) => String(name ?? '').trim().slice(0, 30) || 'Alguém';

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
    /** Os celulares conectados agora, uma entrada por pessoa (o mesmo client_id em duas abas conta uma vez). */
    people(code) {
      const byClient = new Map();
      for (const conn of rooms.get(code) ?? []) {
        if (conn.role === 'controller' && conn.clientId) byClient.set(conn.clientId, { clientId: conn.clientId, name: cleanName(conn.name) });
      }
      return [...byClient.values()];
    },
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
/** A letra que a TV repassa ao palco: só linhas {start, end, text, words?} bem formadas e de tamanho razoável (ou null). */
export function sanitizeCues(cues) {
  if (!Array.isArray(cues) || cues.length > 3000) return null;
  const clean = [];
  for (const cue of cues) {
    if (!Number.isFinite(cue?.start) || !Number.isFinite(cue?.end) || typeof cue?.text !== 'string' || cue.text.length > 400) return null;
    const words = Array.isArray(cue.words) && cue.words.length <= 120 && cue.words.every((w) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]))
      ? cue.words.map((w) => [w[0], w[1]])
      : undefined;
    clean.push({ start: cue.start, end: cue.end, text: cue.text, ...(words ? { words } : {}) });
  }
  return JSON.stringify(clean).length <= 400_000 ? clean : null;
}

export function personalize(base, { clientId, isHost }) {
  return {
    ...base,
    me: { is_host: Boolean(isHost), pid: clientId ? pidOf(clientId) : null },
    queue: base.queue.map(({ client_id: owner, guest_client_id: guestOwner, ...item }) => ({
      ...item,
      mine: owner === clientId,
      can_edit: Boolean(isHost) || owner === clientId,
      guest_me: Boolean(clientId) && guestOwner === clientId && item.guest?.status === 'accepted', // vou cantar junto nesta música
      invite_for_me: Boolean(clientId) && guestOwner === clientId && item.guest?.status === 'pending', // me convidaram: aceitar ou recusar
    })),
  };
}

export function createRoomService({
  db,
  songs,
  hub,
  agents = null, // o serviço do agente local: dá o apelido e o estado (online) do dono da sessão de uma sala
  // intervalo entre músicas: duração dos aplausos e da subida ao palco (0 desliga a fase) e se a sala nasce com ele ligado
  intermission = { applauseMs: 0, stageMs: 0, byDefault: true },
  now = Date.now,
  newCode = generateCode,
  newToken = () => randomBytes(16).toString('hex'),
}) {
  const positions = new Map(); // code -> {item_id, ms}  (efêmero: só a TV sabe, e reporta a cada poucos segundos)
  const lyricsCache = new Map(); // code -> {item_id, cues}: a letra da música que está tocando, enviada pela TV ao palco dos cantores
  const lastKeys = new Map(); // code -> último estado difundido (sem a posição)
  const touched = new Map(); // code -> última vez que gravamos last_active_at
  let timers = [];
  const wakes = new Set(); // despertadores do intervalo entre músicas (um por fim de fase)

  /** Serializes a Room's operations: every command that reads and then changes a Room runs alone, in the order it arrived. */
  const withLock = createSerializer();

  /** Broadcasts the Room's state after the commands queued before it, so a newer state is never followed by an older one. */
  const republish = (code) => withLock(code, () => publish(code)).catch(() => {});

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

  /** O contexto das músicas de uma sala: se ela tem sessão com armazenamento local, as músicas estão no catálogo do dono. */
  const songCtx = (room) => ({ sessionId: room.session_id ?? null });

  async function readySet(items, room) {
    const ids = [...new Set(items.map((i) => i.video_id))];
    const flags = await Promise.all(ids.map((id) => songs.isReady(id, songCtx(room))));
    return new Set(ids.filter((_, i) => flags[i]));
  }

  /**
   * O intervalo entre músicas vale agora nesta sala? Precisa estar ligado pelo anfitrião, ter duração e uma TV para mostrá-lo
   * (sem TV nada toca: esperar não ajudaria ninguém).
   */
  const intermissionOn = (room, ms) => ms > 0 && Boolean(room.intermission) && hub.count(room.code, 'tv') > 0;

  /** Acorda a sala quando uma fase do intervalo termina (o passo periódico também cuida disso; o despertador só é mais pontual). */
  function wakeAt(code, ms) {
    const timer = setTimeout(() => {
      wakes.delete(timer);
      withLock(code, async () => {
        const staged = endStage(code);
        const advanced = await tryAdvance(code);
        if (staged || advanced) await publish(code);
      }).catch(() => {});
    }, ms + 30);
    timer.unref?.();
    wakes.add(timer);
  }

  /** Fim da subida ao palco: a música da vez começa. */
  function endStage(code) {
    const room = db.getRoom(code);
    if (!room || room.playback !== 'intro' || (room.stage_until ?? 0) > now()) return false;
    db.updateRoom(code, { playback: 'playing', stage_until: null });
    return true;
  }

  /**
   * Se nada está tocando, põe o próximo item PRONTO na vez (itens ainda em processamento mantêm a posição). Durante os aplausos
   * a fila espera; com o intervalo ligado, a música da vez entra em "intro" (o cantor sobe ao palco) antes de tocar.
   */
  async function tryAdvance(code, { skipStage = false } = {}) {
    const room = db.getRoom(code);
    if (!room || (room.current_item_id && room.playback !== 'idle')) return false;
    if ((room.applause_until ?? 0) > now()) return false;
    const queued = db.listActive(code).filter((i) => i.status === 'queued');
    const pick = nextPlayable(queued, await readySet(queued, room), { fair: Boolean(room.fair), lastClientId: room.last_client_id });
    if (!pick) {
      if (room.current_item_id || room.playback !== 'idle') db.updateRoom(code, { current_item_id: null, playback: 'idle', stage_until: null });
      return false;
    }
    const stageMs = !skipStage && intermissionOn(room, intermission.stageMs) ? intermission.stageMs : 0;
    db.transaction(() => {
      db.updateItem(pick.id, { status: 'playing', played_at: now() });
      db.touchPlayed(pick.video_id, now()); // base da limpeza do cache por uso (LRU)
      db.updateRoom(code, {
        current_item_id: pick.id,
        playback: stageMs ? 'intro' : 'playing',
        stage_until: stageMs ? now() + stageMs : null,
        applause_item_id: null,
        applause_until: null,
        last_client_id: pick.client_id,
      });
    });
    if (stageMs) wakeAt(code, stageMs);
    positions.delete(code);
    return true;
  }

  /** Os dados de uma música que o intervalo mostra (quem cantou ou vai cantar, o título e a nota, se houve pontuação). */
  function interludeItem(item) {
    return {
      item_id: item.id,
      title: item.title,
      artist: item.artist,
      added_by: item.added_by,
      guest: item.guest_status ? { name: item.guest_name, status: item.guest_status } : null,
      singers: item.guest_status === 'accepted' ? `${item.added_by} & ${item.guest_name}` : item.added_by,
      score: Number.isInteger(item.score) ? item.score : null,
    };
  }

  /** A fase do intervalo em andamento (aplausos ou subida ao palco), com quanto tempo falta; null fora do intervalo. */
  function interludeOf(room) {
    const t = now();
    if (room.playback === 'intro' && room.current_item_id) {
      const item = db.getItem(room.current_item_id);
      if (item) return { phase: 'stage', total_ms: intermission.stageMs, left_ms: Math.max(0, (room.stage_until ?? t) - t), ...interludeItem(item) };
    }
    if (!room.current_item_id && (room.applause_until ?? 0) > t && room.applause_item_id) {
      const item = db.getItem(room.applause_item_id);
      if (item) return { phase: 'applause', total_ms: intermission.applauseMs, left_ms: room.applause_until - t, ...interludeItem(item) };
    }
    return null;
  }

  /** Uma linha no histórico do dono da sessão (salas sem dono, do worker clássico, não têm estatísticas de dono). */
  function logPlay(room, item, outcome) {
    const session = room.session_id ? db.getSession(room.session_id) : null;
    if (!session || !item) return;
    try {
      db.logPlay({
        deviceId: session.device_id,
        sessionId: session.id,
        videoId: item.video_id,
        title: item.title,
        artist: item.artist,
        singer: item.added_by,
        singerKey: createHash('sha256').update(`${session.device_id}:${item.client_id}`).digest('hex').slice(0, 16),
        duet: item.guest_status === 'accepted',
        score: item.score,
        cheers: item.cheers,
        outcome: outcome === 'done' ? 'done' : 'skipped',
        endedAt: now(),
      });
    } catch {
      // o histórico é um extra: nunca derruba a fila
    }
  }

  function finishCurrent(code, status) {
    const room = db.getRoom(code);
    if (!room?.current_item_id) return;
    logPlay(room, db.getItem(room.current_item_id), status);
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
    const described = new Map(await Promise.all(ids.map(async (id) => [id, await songs.describe(id, songCtx(room))])));
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
      voice: Boolean(room.voice),
      voice_volume: room.voice_volume ?? 40,
      melody_bars: Boolean(room.melody_bars),
      // intervalo entre músicas: o ajuste do anfitrião e a fase em andamento (aplausos ou subida ao palco)
      intermission: Boolean(room.intermission),
      interlude: interludeOf(room),
      scoreboard: db.listScored(room.code).map((r) => ({ id: r.id, name: r.guest_status === 'accepted' ? `${r.added_by} & ${r.guest_name}` : r.added_by, title: r.title, score: r.score })),
      // quem está na sala agora (para convidar para um dueto): só o nome e uma identificação que não revela o client_id
      people: hub.people(room.code).map((p) => ({ pid: pidOf(p.clientId), name: p.name })),
      play_order: playOrder(waiting, { fair: Boolean(room.fair), lastClientId: room.last_client_id }).map((i) => i.id),
      playback: room.playback,
      current_item_id: room.current_item_id,
      next_item_id: upNext?.id ?? null,
      position_ms: position?.item_id === room.current_item_id ? position.ms : 0,
      tv_connected: hub.count(room.code, 'tv') > 0,
      // o dono da sessão da sala (só o apelido e se está conectado); null nas salas sem sessão
      owner: room.session_id && agents ? agents.ownerOf(room.session_id) : null,
      // as músicas desta sala estão no computador do dono (armazenamento local): só a TV nele as alcança; o celular não tem prévia
      local_media: Boolean(room.session_id && agents?.libraryOfSession(room.session_id)),
      queue: items.map((item) => {
        const song = described.get(item.video_id);
        return {
          id: item.id,
          video_id: item.video_id,
          title: song?.meta?.title ?? item.title,
          artist: song?.meta?.artist ?? item.artist,
          added_by: item.added_by,
          // dueto: quem canta junto e se já aceitou; `singers` é o que aparece na TV e no placar ("Ana & Bia")
          guest: item.guest_status ? { name: item.guest_name, status: item.guest_status } : null,
          guest_client_id: item.guest_status ? item.guest_client_id : null,
          singers: item.guest_status === 'accepted' ? `${item.added_by} & ${item.guest_name}` : item.added_by,
          client_id: item.client_id,
          pitch: item.pitch,
          backing: item.backing,
          guide: item.guide,
          status: item.status,
          lyric_offset: db.getOffset(item.video_id),
          // dueto: quem canta cada linha, escolhido pelos cantores (texto com a b * -); nulo = a divisão automática
          parts: item.guest_status === 'accepted' ? db.getParts(item.video_id) : null,
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

  // o tempo que falta do intervalo muda a cada passo: não conta como mudança de estado (os aparelhos contam o tempo sozinhos)
  const stateKey = (base) => JSON.stringify({ ...base, position_ms: 0, interlude: base.interlude && { ...base.interlude, left_ms: 0 } });

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
    /** Cria a sala. Com `sessionId`, os pedidos de música dela vão para o agente dono dessa sessão. */
    createRoom({ sessionId = null } = {}) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = newCode();
        const hostToken = newToken();
        // the insert itself refuses a code already taken, so two rooms created at once never share one
        if (!db.createRoom(code, hostToken, now(), sessionId, intermission.byDefault !== false)) continue;
        return { code, host_token: hostToken };
      }
      throw new HttpError(503, 'no_room_code', 'Não consegui criar uma sala agora. Tente de novo.');
    },

    /** A sessão a que a sala pertence (null = sala sem sessão); 404 se a sala não existe. */
    sessionIdOf: (code) => requireRoom(code).session_id ?? null,

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
        if (!(await songs.isReady(videoId, songCtx(room))) && !(artist && title)) {
          throw new HttpError(400, 'artist_title_required', 'Informe o artista e o nome da música.');
        }
        if (db.countQueued(room.code) >= MAX_QUEUE) throw new HttpError(409, 'queue_full', 'A fila está cheia.');
        if (db.countQueuedBy(room.code, actor.clientId) >= MAX_PER_CLIENT) {
          throw new HttpError(409, 'too_many', `Cada pessoa pode ter até ${MAX_PER_CLIENT} músicas na fila.`);
        }
        const song = await songs.request(videoId, { lyrics: params.lyrics, artist, title }, { sessionId: room.session_id ?? null });
        if (song.error === 'imported_not_found') throw new HttpError(404, 'song_not_found', 'Esta música importada não está na biblioteca do dono.');
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

    /**
     * Dueto: o dono da música (ou o anfitrião) convida alguém que está NA SALA agora (`pid`, da lista `people`) para cantar junto.
     * A pessoa precisa aceitar. Só um convidado por música; convidar de novo troca o convidado. Vale para músicas que aguardam
     * e para a que já está tocando.
     */
    invite(code, itemId, pid, actor) {
      return mutate(code, actor, (room) => {
        const item = requireItem(room, itemId);
        requireEditable(room, item, actor);
        // vale também para a música que já está tocando: quem aceitar entra no dueto no meio dela
        const guest = hub.people(room.code).find((p) => pidOf(p.clientId) === pid);
        if (!guest) throw new HttpError(404, 'person_not_found', 'Essa pessoa não está mais na sala.');
        if (guest.clientId === item.client_id) throw new HttpError(400, 'invite_self', 'Você não pode convidar a si mesmo.');
        db.updateItem(item.id, { guest_client_id: guest.clientId, guest_name: guest.name, guest_status: 'pending' });
      });
    },

    /** O dono (ou o anfitrião) desfaz o convite ou tira o convidado. */
    cancelInvite(code, itemId, actor) {
      return mutate(code, actor, (room) => {
        const item = requireItem(room, itemId);
        requireEditable(room, item, actor);
        db.updateItem(item.id, { guest_client_id: null, guest_name: null, guest_status: null });
      });
    },

    /** O convidado aceita (vai cantar junto) ou recusa (o convite some). */
    respondInvite(code, itemId, accept, actor) {
      return mutate(code, actor, (room) => {
        const item = requireItem(room, itemId);
        if (!actor.clientId || item.guest_client_id !== actor.clientId || item.guest_status !== 'pending') {
          throw new HttpError(404, 'invite_not_found', 'Este convite não existe mais.');
        }
        if (accept) db.updateItem(item.id, { guest_status: 'accepted' });
        else db.updateItem(item.id, { guest_client_id: null, guest_name: null, guest_status: null });
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

    /** Tom, nível das vozes de apoio e da voz original (guia) de uma música da fila: só quem a escolheu (ou o anfitrião) muda. */
    setItemSettings(code, itemId, { pitch, backing, guide }, actor) {
      return mutate(code, actor, (room) => {
        const item = requireItem(room, itemId);
        requireEditable(room, item, actor);
        db.updateItem(item.id, {
          ...(pitch === undefined ? {} : { pitch: clampPitch(pitch) }),
          ...(backing === undefined ? {} : { backing: clampBacking(backing) }),
          ...(guide === undefined ? {} : { guide: clampGuide(guide) }),
        });
      });
    },

    /**
     * Skips the song playing (Host only). With `itemId` (the song on the Host's screen), a song that already ended is not
     * skipped again: otherwise a skip arriving right after the TV's "ended" would skip the next singer's song.
     */
    skip(code, actor, itemId = null) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        if (itemId !== null && room.current_item_id !== itemId) return;
        finishCurrent(room.code, 'skipped');
      });
    },

    /** Pula o intervalo entre músicas (só o anfitrião): acaba com os aplausos e com a subida ao palco, e a música da vez toca já. */
    startNow(code, actor) {
      return mutate(code, actor, async (room) => {
        requireHost(room, actor);
        if (room.playback === 'intro') {
          db.updateRoom(room.code, { playback: 'playing', stage_until: null });
        } else if ((room.applause_until ?? 0) > now()) {
          db.updateRoom(room.code, { applause_item_id: null, applause_until: null });
          await tryAdvance(room.code, { skipStage: true });
        }
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

    /**
     * Ajustes da sala, só do anfitrião: `fair` (rodízio justo), `scoring` (pontuação pelo microfone), `voice` (a voz do
     * microfone da TV sai nas caixas junto com a música), `voice_volume` (0 a 100) e `melody_bars` (o guia de melodia na TV).
     */
    setSettings(code, settings, actor) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        const fields = {};
        if (typeof settings.fair === 'boolean') fields.fair = settings.fair ? 1 : 0;
        if (typeof settings.scoring === 'boolean') fields.scoring = settings.scoring ? 1 : 0;
        if (typeof settings.voice === 'boolean') fields.voice = settings.voice ? 1 : 0;
        if (typeof settings.melody_bars === 'boolean') fields.melody_bars = settings.melody_bars ? 1 : 0;
        if (Number.isInteger(settings.voice_volume)) fields.voice_volume = Math.min(100, Math.max(0, settings.voice_volume));
        if (typeof settings.intermission === 'boolean') {
          fields.intermission = settings.intermission ? 1 : 0;
          // desligado no meio do intervalo: os aplausos acabam e a música da vez começa
          if (!settings.intermission) {
            Object.assign(fields, { applause_item_id: null, applause_until: null, stage_until: null });
            if (room.playback === 'intro') fields.playback = 'playing';
          }
        }
        db.updateRoom(room.code, fields);
      });
    },

    /** Pontuação final enviada pela TV ao fim da música (só vale com a pontuação ligada e para o item que está tocando). */
    tvScore(code, itemId, score) {
      const normalized = normalizeCode(code);
      return withLock(normalized, async () => {
        const room = db.getRoom(normalized);
        const item = db.getItem(itemId);
        if (!room?.scoring || !item || item.room_code !== room.code || item.status !== 'playing') return;
        if (!Number.isInteger(score) || score < 0 || score > 100) return;
        db.updateItem(item.id, { score });
        await publish(normalized);
      });
    },

    setOffset(code, videoId, offset, actor) {
      return mutate(code, actor, (room) => {
        requireHost(room, actor);
        db.setOffset(videoId, clampOffset(offset));
      });
    },

    /**
     * A divisão da letra de um dueto: vale para a música em qualquer sala. Quem muda: o anfitrião ou um dos cantores de uma
     * música dessas que está na fila (o dono e o convidado). `parts` nulo volta à divisão automática.
     */
    setParts(code, videoId, parts, actor) {
      let clean;
      try {
        clean = cleanParts(parts);
      } catch {
        throw new HttpError(400, 'invalid_parts', 'Divisão da letra inválida.');
      }
      return mutate(code, actor, (room) => {
        const mine = db
          .listActive(room.code)
          .some((i) => i.video_id === videoId && (i.client_id === actor.clientId || (i.guest_status === 'accepted' && i.guest_client_id === actor.clientId)));
        if (!(hostCheck(room, actor.hostToken) || mine)) throw new HttpError(403, 'not_your_item', 'Você só pode alterar as suas músicas.');
        db.setParts(videoId, clean);
      });
    },

    /** Evento da TV: a música terminou (ignorado se não for a atual: idempotente). */
    tvEnded(code, itemId) {
      const normalized = normalizeCode(code);
      return withLock(normalized, async () => {
        const room = db.getRoom(normalized);
        if (!room || room.current_item_id !== itemId) return;
        finishCurrent(normalized, 'done');
        // fim natural: aplausos para quem cantou antes de a próxima subir ao palco
        if (intermissionOn(room, intermission.applauseMs)) {
          db.updateRoom(normalized, { applause_item_id: itemId, applause_until: now() + intermission.applauseMs });
          wakeAt(normalized, intermission.applauseMs);
        }
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

    /** Evento da TV: a letra da música que ela carregou. Vai para os celulares (o palco desenha a letra com ela). */
    tvLyrics(code, itemId, cues) {
      const normalized = normalizeCode(code);
      const room = db.getRoom(normalized);
      const clean = sanitizeCues(cues);
      if (!room || room.current_item_id !== itemId || !clean) return;
      lyricsCache.set(normalized, { item_id: itemId, cues: clean });
      hub.broadcast(normalized, (conn) => (conn.role === 'controller' ? { type: 'lyrics', item_id: itemId, cues: clean } : null));
    },

    /** Registra uma conexão WebSocket; devolve `leave` para chamar ao fechar. Lança 404 se a sala não existe. */
    connect(code, { socket, role, clientId, hostToken, name }) {
      const room = requireRoom(code);
      const conn = {
        socket,
        role: role === 'tv' ? 'tv' : 'controller',
        clientId: clientId ?? '',
        name: name ? cleanName(name) : '',
        isHost: hostCheck(room, hostToken),
        alive: true,
        reactions: createBucket(), // limite de reações por conexão
      };
      const remove = hub.add(room.code, conn);
      // quem chega no meio da música (o palco do cantor abre depois que ela começou) recebe a letra que a TV já mandou
      const cached = lyricsCache.get(room.code);
      if (conn.role === 'controller' && cached && cached.item_id === room.current_item_id && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'lyrics', item_id: cached.item_id, cues: cached.cues }));
      }
      republish(room.code);
      return {
        conn,
        leave() {
          remove();
          republish(room.code);
        },
      };
    },

    /** As estatísticas de um dono (computador pareado) desde `since` (ms). */
    statsFor: (deviceId, since) => db.statsFor(deviceId, since),

    /** Mensagem recebida por WebSocket (só a TV envia comandos). */
    onMessage(code, conn, raw) {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      // o celular diz o nome da pessoa (para a lista de quem está na sala, usada nos convites de dueto)
      if (conn.role === 'controller' && message?.type === 'hello' && typeof message.name === 'string') {
        const name = cleanName(message.name);
        if (name !== conn.name) {
          conn.name = name;
          republish(code);
        }
        return;
      }
      // uma reação (aplauso, fogo...): vai para a TV e para quem está olhando a TV ou o palco; conta para a música que toca
      if (conn.role === 'controller' && message?.type === 'reaction') {
        if (!REACTION_KINDS.includes(message.kind) || !conn.reactions.take(now())) return;
        if (!db.getRoom(code)) return;
        db.addCheersToCurrent(code, 1); // one statement: the cheer goes to the song playing when it arrives, never to the next one
        hub.broadcast(code, () => ({ type: 'reaction', kind: message.kind, name: conn.name }));
        return;
      }
      if (conn.role !== 'tv') return;
      if (!Number.isInteger(message?.item_id)) return;
      if (message.type === 'score') this.tvScore(code, message.item_id, message.score).catch(() => {});
      else if (message.type === 'ended') this.tvEnded(code, message.item_id).catch(() => {});
      else if (message.type === 'position' && Number.isFinite(message.ms)) this.tvPosition(code, message.item_id, message.ms);
      else if (message.type === 'lyrics') this.tvLyrics(code, message.item_id, message.cues);
    },

    /** Passo periódico: avança a fila quando uma música fica pronta e difunde mudanças (progresso do processamento). */
    async tick() {
      for (const code of hub.codes()) {
        await withLock(code, async () => {
          try {
            const staged = endStage(code);
            const advanced = await tryAdvance(code);
            const base = await snapshot(code);
            if (staged || advanced || stateKey(base) !== lastKeys.get(code)) publishBase(code, base);
          } catch {
            // sala removida ou storage indisponível: tenta de novo no próximo passo
          }
        });
      }
    },

    start({ tickMs = 1500 } = {}) {
      db.deleteInactiveRooms(now() - ROOM_TTL_MS);
      db.prunePlayLog(now() - PLAY_LOG_TTL_MS);
      timers = [
        setInterval(() => this.tick(), tickMs),
        setInterval(() => hub.heartbeat(), 30_000),
        setInterval(() => db.deleteInactiveRooms(now() - ROOM_TTL_MS), 60 * 60 * 1000),
        setInterval(() => db.prunePlayLog(now() - PLAY_LOG_TTL_MS), 24 * 60 * 60 * 1000),
      ];
      for (const timer of timers) timer.unref();
    },

    stop() {
      for (const timer of timers) clearInterval(timer);
      timers = [];
      for (const timer of wakes) clearTimeout(timer);
      wakes.clear();
    },
  };
}
