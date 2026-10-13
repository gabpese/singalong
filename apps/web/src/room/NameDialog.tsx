// A primeira coisa ao entrar na sala: quem é você? O nome aparece na fila, nos convites de dueto e na pontuação, então o
// modal não fecha sem ele (depois a pessoa ainda pode trocá-lo na aba "Adicionar").
import { useEffect, useRef, useState, type FormEvent } from 'react';

export function NameDialog({ code, onName }: { code: string; onName: (name: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) onName(value.trim());
  }

  return (
    <dialog
      ref={dialog}
      className="jukebox-dialog name-dialog"
      aria-labelledby="name-title"
      onCancel={(event) => event.preventDefault()} // Esc não fecha: o nome é obrigatório
    >
      <form className="jukebox-body" onSubmit={submit}>
        <h2 id="name-title">Bem-vindo à sala {code}!</h2>
        <p className="muted">Como você quer aparecer? Esse nome vai na fila, nos convites de dueto e na pontuação.</p>
        <label className="field">
          <span>Seu nome</span>
          <input
            type="text"
            maxLength={30}
            autoFocus
            autoComplete="nickname"
            placeholder="Seu nome ou apelido"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="jukebox-actions">
          <button type="submit" className="primary" disabled={!value.trim()}>
            Entrar na sala
          </button>
        </div>
      </form>
    </dialog>
  );
}
