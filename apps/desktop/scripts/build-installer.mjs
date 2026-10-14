// Gera o instalador do Windows: apps/desktop/dist/singalong_karaoke.exe (+ latest.yml para a atualização automática).
//   npm run dist          → instalador
//   npm run dist:dir      → só a pasta descompactada (rápido, para testar)
//   SINGALONG_DIST=pasta  → gera em outra pasta (os testes de atualização usam para ter duas versões lado a lado)
// Assinatura: sem certificado configurado sai sem assinar (o Windows mostra o aviso do SmartScreen); com CSC_LINK + CSC_KEY_PASSWORD,
// ou com o Azure Trusted Signing, sai assinado e carimbado. Veja scripts/signing.mjs. SINGALONG_REQUIRE_SIGNING=1 falha sem certificado.
import { join } from 'node:path';
import { build, Platform } from 'electron-builder';
import { resolveSigning } from './signing.mjs';
import { judge, readSignature } from './verify-signature.mjs';

const dirOnly = process.argv.includes('--dir');
const signing = resolveSigning(process.env);
console.log(`Assinatura: ${signing.summary}`);
if (signing.mode === 'none') process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'; // nunca "descobre" um certificado do computador por conta própria

const output = process.env.SINGALONG_DIST || 'dist';
const result = await build({
  targets: Platform.WINDOWS.createTarget(dirOnly ? 'dir' : 'nsis', 1 /* x64 */),
  publish: 'never',
  config: {
    directories: { output, buildResources: 'build' },
    // o endereço verdadeiro vem do servidor (APP_DOWNLOAD_URL) na hora de atualizar; aqui só faz o latest.yml existir
    publish: [{ provider: 'generic', url: 'https://invalid.example/updates/' }],
    win: signing.win,
  },
});
console.log(result.join('\n'));

// conferência: o que devia sair assinado saiu assinado (e nada sai assinado sem querer)
const files = dirOnly ? [join(output, 'win-unpacked', 'singalong_karaoke.exe')] : result.filter((file) => file.toLowerCase().endsWith('.exe'));
let failed = false;
for (const file of files) {
  const report = await readSignature(file);
  const problems = judge(report, { expectUnsigned: signing.mode === 'none' });
  console.log(`  ${file}: ${report.status}${report.subject ? `, ${report.subject}` : ''}${problems.length ? ` ✗ ${problems.join('; ')}` : ' ✓'}`);
  if (problems.length) failed = true;
}
if (failed) process.exit(1);
