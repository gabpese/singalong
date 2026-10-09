// Entrada: criar uma sala (e abrir a TV) ou entrar numa sala pelo código.
import { type FormEvent, useState } from 'react';
import { api, setHostToken } from '../lib/identity.js';
import { Icon } from '../ui/Icon';

interface ApiError extends Error {
  status?: number;
}

export function Landing() {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');

  async function createRoom() {
    try {
      const { code: roomCode, host_token: token } = await api('POST', '/api/rooms');
      setHostToken(roomCode, token);
      // aberta dentro do clique para o navegador não bloquear a aba da TV; na sala há um botão "Abrir TV" se bloquear
      window.open(`tv.html?room=${roomCode}`, '_blank');
      location.href = `room.html?room=${roomCode}`;
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    const roomCode = code.trim().toUpperCase();
    try {
      await api('GET', `/api/rooms/${encodeURIComponent(roomCode)}`);
      location.href = `room.html?room=${roomCode}`;
    } catch (err) {
      const error = err as ApiError;
      setMessage(error.status === 404 ? `Não achei a sala ${roomCode}. Confira o código.` : error.message);
    }
  }

  return (
    <main className="landing-page">
      <h1>
        <Icon name="singing" />
        Singalong
      </h1>
      <p className="lead">Karaokê de qualquer vídeo do YouTube: o instrumental, a letra sincronizada e a fila da festa.</p>

      <section className="card">
        <h2>Criar uma sala</h2>
        <p className="hint">Você será o anfitrião: escolhe a ordem, pula e pausa. A TV abre em outra aba.</p>
        <button type="button" className="primary big" onClick={createRoom}>
          Criar sala e abrir a TV
        </button>
      </section>

      <section className="card">
        <h2>Entrar numa sala</h2>
        <form className="row" autoComplete="off" onSubmit={join}>
          <input
            type="text"
            inputMode="text"
            maxLength={8}
            placeholder="Código (ex.: K7QM)"
            aria-label="Código da sala"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button type="submit">Entrar</button>
        </form>
      </section>

      <p className={`hint${message ? ' error' : ''}`} role="status">
        {message}
      </p>
    </main>
  );
}
