import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// Four pages (the landing, the Room, the TV and the Stage) at the usual URLs: /, /room.html?room=..., /tv.html?room=... and /stage.html?room=...
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: { input: { index: page('index.html'), room: page('room.html'), tv: page('tv.html'), stage: page('stage.html') } },
  },
  // development: `npm run dev` opens the pages with hot reload and sends the API to the server on :3000
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', ws: true }, '/media': 'http://localhost:3000' },
  },
});
