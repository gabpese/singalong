// Checks an assembled engine: each program answers, and ffmpeg has the codecs and filters the karaoke uses.
import { join } from 'node:path';
import { run } from './assemble.ts';
import { launchEnv, paths } from './engine.ts';

// What each one is for: libx264/aac = the export's MP4; libmp3lame = the Jukebox's MP3s; rubberband = the Key change;
// subtitles (libass) = the lyrics burned into the video.
export const FFMPEG_ENCODERS = ['libx264', 'aac', 'libmp3lame'];
export const FFMPEG_FILTERS = ['rubberband', 'subtitles'];
// macOS's static ffmpeg builds lack rubberband: there the Key change uses asetrate/atempo (the worker detects it and picks)
export const filtersFor = (platform: string = process.platform) => (platform === 'darwin' ? FFMPEG_FILTERS.filter((name) => name !== 'rubberband') : FFMPEG_FILTERS);

const PY_IMPORTS = ['torch', 'torchaudio', 'demucs', 'stable_whisper', 'librosa', 'yt_dlp', 'audio_separator', 'onnxruntime', 'websockets', 'redis', 'langdetect'];

export const missingNames = (output: string, names: string[]) => names.filter((name) => !new RegExp(`\\b${name}\\b`).test(output));

export interface EngineCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Returns { ok, checks: [{ name, ok, detail }] }; it never throws because a program failed. */
export async function verifyEngine(root: string, { runImpl = run }: { runImpl?: typeof run } = {}): Promise<{ ok: boolean; checks: EngineCheck[] }> {
  const p = paths(root);
  const env = launchEnv(root);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const checks: EngineCheck[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: String((error as Error).message ?? error).slice(0, 400) });
    }
  };
  const exec = (command: string, args: string[]) => runImpl(command, args, { cwd: root, env });

  await check('ffmpeg (GPL)', async () => {
    const out = await exec(join(p.bin, `ffmpeg${ext}`), ['-hide_banner', '-version']);
    if (!/--enable-gpl/.test(out)) throw new Error('o ffmpeg não é uma versão GPL (faltam libx264/libass/rubberband)');
    return out.split(/\r?\n/)[0];
  });
  await check('ffmpeg: codecs de saída', async () => {
    const missing = missingNames(await exec(join(p.bin, `ffmpeg${ext}`), ['-hide_banner', '-encoders']), FFMPEG_ENCODERS);
    if (missing.length) throw new Error(`faltam: ${missing.join(', ')}`);
    return FFMPEG_ENCODERS.join(', ');
  });
  await check('ffmpeg: filtros (tom e letra)', async () => {
    const wanted = filtersFor();
    const output = await exec(join(p.bin, `ffmpeg${ext}`), ['-hide_banner', '-filters']);
    const missing = missingNames(output, wanted);
    if (missing.length) throw new Error(`faltam: ${missing.join(', ')}`);
    return wanted.length === FFMPEG_FILTERS.length ? wanted.join(', ') : `${wanted.join(', ')} (sem rubberband: o tom usa asetrate/atempo)`;
  });
  await check('ffprobe', async () => (await exec(join(p.bin, `ffprobe${ext}`), ['-version'])).split(/\r?\n/)[0]);
  await check('deno (desafios do YouTube)', async () => (await exec(join(p.bin, `deno${ext}`), ['--version'])).split(/\r?\n/)[0]);
  await check('python e pacotes', async () => {
    const code = [
      'import importlib, sys',
      'bad = []',
      `for n in ${JSON.stringify(PY_IMPORTS)}:`,
      '    try: importlib.import_module(n)',
      '    except Exception as e: bad.append(n + ": " + str(e)[:80])',
      'if bad:',
      '    print("FALTAM", bad); sys.exit(1)',
      'import torch',
      'print(sys.version.split()[0], "torch", torch.__version__)',
    ].join('\n');
    return (await exec(p.python, ['-I', '-c', code])).trim().split(/\r?\n/).pop()!;
  });
  await check('o aplicativo do worker inicia', async () => (await exec(p.python, ['-m', 'singalong_worker', '--version'])).trim());
  return { ok: checks.every((c) => c.ok), checks };
}
