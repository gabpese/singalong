// Gera o instalador do Windows: apps/desktop/dist/singalong_karaoke.exe (+ latest.yml para a atualização automática).
//   npm run dist          → instalador
//   npm run dist:dir      → só a pasta descompactada (rápido, para testar)
//   SINGALONG_DIST=pasta  → gera em outra pasta (os testes de atualização usam para ter duas versões lado a lado)
// Não assina: o instalador é distribuído só para quem o dono escolher (o Windows mostra o aviso do SmartScreen).
import { build, Platform } from 'electron-builder';

const dirOnly = process.argv.includes('--dir');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const result = await build({
  targets: Platform.WINDOWS.createTarget(dirOnly ? 'dir' : 'nsis', 1 /* x64 */),
  publish: 'never',
  config: {
    directories: { output: process.env.SINGALONG_DIST || 'dist', buildResources: 'build' },
    // o endereço verdadeiro vem do servidor (APP_DOWNLOAD_URL) na hora de atualizar; aqui só faz o latest.yml existir
    publish: [{ provider: 'generic', url: 'https://invalid.example/updates/' }],
  },
});
console.log(result.join('\n'));
