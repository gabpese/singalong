import { createRoot } from 'react-dom/client';
import { parseHostHash, parseRoomCode, setHostToken } from '../lib/identity.ts';
import '../styles/style.css';
import { RoomPage } from './RoomPage';

const code: string | null = parseRoomCode(location.search);
if (!code) {
  location.replace('/');
} else {
  // the Host link (#host=TOKEN): keeps the token and takes it out of the address bar
  const fromLink: string | null = parseHostHash(location.hash);
  if (fromLink) {
    setHostToken(code, fromLink);
    history.replaceState(null, '', location.pathname + location.search);
  }
  createRoot(document.getElementById('root')!).render(<RoomPage code={code} />);
}
