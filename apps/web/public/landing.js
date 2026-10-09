import { api, setHostToken } from './identity.js';

const $ = (id) => document.getElementById(id);
const status = $('status');

function show(text, isError = true) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

$('create').addEventListener('click', async () => {
  try {
    const { code, host_token: token } = await api('POST', '/api/rooms');
    setHostToken(code, token);
    // aberta dentro do clique para o navegador não bloquear a aba da TV; na sala há um botão "Abrir TV" se bloquear
    window.open(`tv.html?room=${code}`, '_blank');
    location.href = `room.html?room=${code}`;
  } catch (err) {
    show(err.message);
  }
});

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  try {
    await api('GET', `/api/rooms/${encodeURIComponent(code)}`);
    location.href = `room.html?room=${code}`;
  } catch (err) {
    show(err.status === 404 ? `Não achei a sala ${code}. Confira o código.` : err.message);
  }
});
