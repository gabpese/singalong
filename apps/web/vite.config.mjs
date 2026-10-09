import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name) => fileURLToPath(new URL(name, import.meta.url));

// Três páginas (entrada, sala e TV) com as URLs de sempre: /, /room.html?room=... e /tv.html?room=...
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: { input: { index: page('index.html'), room: page('room.html'), tv: page('tv.html') } },
  },
  // desenvolvimento: `npm run dev` abre o front-end com recarga rápida e manda a API para o servidor em :3000
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', ws: true }, '/media': 'http://localhost:3000' },
  },
});
