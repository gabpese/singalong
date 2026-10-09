import { createRoot } from 'react-dom/client';
import { parseRoomCode } from '../lib/identity.js';
import '../styles/style.css';
import { TvPage } from './TvPage';

const code: string | null = parseRoomCode(location.search);
const root = createRoot(document.getElementById('root')!);

if (code) {
  root.render(<TvPage code={code} />);
} else {
  root.render(
    <main className="tv-stage">
      <footer className="tv-bottom">
        <p className="hint" role="status">
          Abra a TV a partir de uma sala (link com ?room=CÓDIGO).
        </p>
      </footer>
    </main>,
  );
}
