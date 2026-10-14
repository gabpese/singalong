// Gera o instalador do app: apps/desktop/dist/ (+ o arquivo de atualização automática, latest*.yml). Cada sistema se gera no próprio sistema
// (o DMG só no macOS; no CI há um job por sistema):
//   npm run dist                      → o instalador do sistema em que você está
//   npm run dist -- --platform=linux  → AppImage (win | mac | linux; o nome do arquivo é fixo por sistema, veja src/installers.js)
//   npm run dist:dir                  → só a pasta descompactada (rápido, para testar)
//   SINGALONG_DIST=pasta              → gera em outra pasta (os testes de atualização usam para ter duas versões lado a lado)
// Windows: sem certificado configurado sai sem assinar (o SmartScreen avisa); com CSC_LINK + CSC_KEY_PASSWORD, ou com o Azure Trusted Signing,
// sai assinado e carimbado (scripts/signing.mjs). SINGALONG_REQUIRE_SIGNING=1 falha sem certificado.
// macOS: sai com assinatura "ad-hoc" (o Apple Silicon só abre programas assinados; sem conta Apple Developer não há como notarizar).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { INSTALLERS } from '../src/installers.js';
import { resolveSigning } from './signing.mjs';
import { judge, readSignature } from './verify-signature.mjs';

const dirOnly = process.argv.includes('--dir');
const HOST = { win32: 'win', darwin: 'mac', linux: 'linux' };
const chosen = process.argv.find((arg) => arg.startsWith('--platform='))?.split('=')[1] ?? HOST[process.platform];
if (!['win', 'mac', 'linux'].includes(chosen)) {
  console.error('Sistema desconhecido. Use --platform=win, --platform=mac ou --platform=linux.');
  process.exit(2);
}
if (chosen === 'mac' && process.platform !== 'darwin') {
  console.error('O DMG só pode ser gerado no macOS.');
  process.exit(2);
}

const TARGETS = {
  win: { platform: Platform.WINDOWS, type: 'nsis', arch: Arch.x64, file: INSTALLERS['win32-x64'] },
  mac: { platform: Platform.MAC, type: 'dmg', arch: Arch.arm64, file: INSTALLERS['darwin-arm64'] },
  linux: { platform: Platform.LINUX, type: 'AppImage', arch: Arch.x64, file: INSTALLERS['linux-x64'] },
};
const target = TARGETS[chosen];

const signing = chosen === 'win' ? resolveSigning(process.env) : null;
if (signing) {
  console.log(`Assinatura: ${signing.summary}`);
  if (signing.mode === 'none') process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'; // nunca "descobre" um certificado do computador por conta própria
}

const output = process.env.SINGALONG_DIST || 'dist';
const result = await build({
  targets: target.platform.createTarget(dirOnly ? 'dir' : target.type, target.arch),
  publish: 'never',
  config: {
    directories: { output, buildResources: 'build' },
    // o endereço verdadeiro vem do servidor (APP_DOWNLOAD_URL) na hora de atualizar; aqui só faz o latest.yml existir
    publish: [{ provider: 'generic', url: 'https://invalid.example/updates/' }],
    ...(signing ? { win: signing.win } : {}),
  },
});
console.log(result.join('\n'));

// conferência: o que devia sair certo saiu certo
let failed = false;
const problem = (text) => {
  console.error(`  ✗ ${text}`);
  failed = true;
};

if (chosen === 'win') {
  // o que devia sair assinado saiu assinado (e nada sai assinado sem querer)
  const files = dirOnly ? [join(output, 'win-unpacked', 'singalong_karaoke.exe')] : result.filter((file) => file.toLowerCase().endsWith('.exe'));
  for (const file of files) {
    const report = await readSignature(file);
    const problems = judge(report, { expectUnsigned: signing.mode === 'none' });
    console.log(`  ${file}: ${report.status}${report.subject ? `, ${report.subject}` : ''}${problems.length ? ` ✗ ${problems.join('; ')}` : ' ✓'}`);
    if (problems.length) failed = true;
  }
} else if (!dirOnly) {
  const file = join(output, target.file);
  if (!existsSync(file)) {
    problem(`faltou o arquivo ${file} (o nome é fixo: o servidor monta o link de download com ele)`);
  } else {
    const size = statSync(file).size;
    if (size < 50 * 1024 * 1024) problem(`${file} tem só ${Math.round(size / 1024 / 1024)} MB: parece incompleto`);
    if (chosen === 'linux') {
      const head = readFileSync(file).subarray(0, 4);
      if (!head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) problem(`${file} não é um executável do Linux (ELF)`);
      if ((statSync(file).mode & 0o111) === 0) problem(`${file} não tem permissão de executar`);
      if (!existsSync(join(output, 'latest-linux.yml'))) problem('faltou o latest-linux.yml (a atualização automática do Linux depende dele)');
    }
    console.log(`  ${file}: ${Math.round(size / 1024 / 1024)} MB${failed ? '' : ' ✓'}`);
  }
  if (chosen === 'mac') {
    // o Apple Silicon encerra qualquer programa sem assinatura: a ad-hoc tem de estar válida
    const app = join(output, 'mac-arm64', 'Singalong Karaoke.app');
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
      console.log(`  ${app}: assinatura ad-hoc válida ✓`);
    } catch (error) {
      problem(`a assinatura de ${app} não confere: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
}
if (failed) process.exit(1);
