import { createRoot } from 'react-dom/client';
import { parseRoomCode } from '../lib/identity.ts';
import '../styles/style.css';
import { StagePage } from './StagePage';

const code: string | null = parseRoomCode(location.search);
if (!code) location.replace('/');
else createRoot(document.getElementById('root')!).render(<StagePage code={code} />);
