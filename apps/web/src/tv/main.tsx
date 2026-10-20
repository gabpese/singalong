import { createRoot } from 'react-dom/client';
import { t } from '../i18n/index.ts';
import { parseRoomCode } from '../lib/identity.ts';
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
          {t('tvp.noRoom')}
        </p>
      </footer>
    </main>,
  );
}
