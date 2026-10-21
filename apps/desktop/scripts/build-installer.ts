// Makes the app's installer: apps/desktop/dist/ (plus the automatic update's file, latest*.yml). Each system's is made on that
// system (the DMG only on macOS; CI has one job per system):
//   npm run dist                      → the installer of the system you are on
//   npm run dist -- --platform=linux  → AppImage (win | mac | linux; the file's name is fixed per system, see src/installers.ts)
//   npm run dist:dir                  → only the unpacked folder (fast, for testing)
//   SINGALONG_DIST=folder             → makes it in another folder (the update tests use it to keep two versions side by side)
// Windows: without a certificate configured it comes out unsigned (SmartScreen warns); with CSC_LINK + CSC_KEY_PASSWORD, or with
// Azure Trusted Signing, it comes out signed and time-stamped (scripts/signing.ts). SINGALONG_REQUIRE_SIGNING=1 fails without one.
// macOS: it comes out with an "ad-hoc" signature (Apple Silicon only opens signed programs; without an Apple Developer account
// there is no way to notarize).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { INSTALLERS } from '../src/installers.ts';
import { resolveSigning } from './signing.ts';
import { judge, readSignature } from './verify-signature.ts';

// the engine's dist/ and the window's compiled scripts and preloads go into the installer
execSync('npm run build', { cwd: new URL('..', import.meta.url), stdio: 'inherit' });

type System = 'win' | 'mac' | 'linux';
const dirOnly = process.argv.includes('--dir');
const HOST: Record<string, System> = { win32: 'win', darwin: 'mac', linux: 'linux' };
const chosen = process.argv.find((arg) => arg.startsWith('--platform='))?.split('=')[1] ?? HOST[process.platform];
if (chosen !== 'win' && chosen !== 'mac' && chosen !== 'linux') {
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
  if (signing.mode === 'none') process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'; // never "discovers" a certificate of the computer on its own
}

// the Mac's ad-hoc signature uses no secret; without this electron-builder skips it on pull request builds and the app would come out unsigned
if (chosen === 'mac') process.env.CSC_FOR_PULL_REQUEST = 'true';

const output = process.env.SINGALONG_DIST || 'dist';
const result = await build({
  targets: target.platform.createTarget(dirOnly ? 'dir' : target.type, target.arch),
  publish: 'never',
  config: {
    directories: { output, buildResources: 'build' },
    // the real address comes from the server (APP_DOWNLOAD_URL) at update time; here it only makes latest.yml exist
    publish: [{ provider: 'generic', url: 'https://invalid.example/updates/' }],
    ...(signing ? { win: signing.win } : {}),
  },
});
console.log(result.join('\n'));

// the check: what should come out right came out right
let failed = false;
const problem = (text: string) => {
  console.error(`  ✗ ${text}`);
  failed = true;
};

if (chosen === 'win') {
  // what should come out signed came out signed (and nothing comes out signed by accident)
  const files = dirOnly ? [join(output, 'win-unpacked', 'singalong_karaoke.exe')] : result.filter((file) => file.toLowerCase().endsWith('.exe'));
  for (const file of files) {
    const report = await readSignature(file);
    const problems = judge(report, { expectUnsigned: signing?.mode === 'none' });
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
    // Apple Silicon kills any unsigned program: the ad-hoc signature must be valid
    const folder = join(output, 'mac-arm64');
    const name = existsSync(folder) ? readdirSync(folder).find((entry) => entry.endsWith('.app')) : null;
    if (!name) {
      problem(`não achei o .app em ${folder} (${existsSync(folder) ? readdirSync(folder).join(', ') || 'pasta vazia' : 'a pasta não existe'})`);
    } else {
      const app = join(folder, name);
      try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
        console.log(`  ${app}: assinatura ad-hoc válida ✓`);
      } catch (error) {
        const failure = error as Error & { stderr?: Buffer };
        problem(`a assinatura de ${app} não confere: ${String(failure.stderr ?? failure.message).trim()}`);
      }
    }
  }
}
if (failed) process.exit(1);
