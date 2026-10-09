import { createRoot } from 'react-dom/client';
import { parseHostHash, parseRoomCode, setHostToken } from '../lib/identity.js';
import '../styles/style.css';
import { RoomPage } from './RoomPage';

const code: string | null = parseRoomCode(location.search);
if (!code) {
  location.replace('/');
} else {
  // link de anfitrião (#host=TOKEN): guarda o token e tira da barra de endereço
  const fromLink: string | null = parseHostHash(location.hash);
  if (fromLink) {
    setHostToken(code, fromLink);
    history.replaceState(null, '', location.pathname + location.search);
  }
  createRoot(document.getElementById('root')!).render(<RoomPage code={code} />);
}
