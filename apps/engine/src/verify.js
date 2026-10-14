// Confere um motor já montado: cada programa responde e o ffmpeg tem os codecs e filtros que o karaokê usa.
import { join } from 'node:path';
import { run } from './assemble.js';
import { launchEnv, paths } from './engine.js';

// Para que serve cada um: libx264/aac = MP4 da exportação; libmp3lame = os MP3 da biblioteca;
// rubberband = troca de tom; subtitles (libass) = letra queimada no vídeo.
export const FFMPEG_ENCODERS = ['libx264', 'aac', 'libmp3lame'];
export const FFMPEG_FILTERS = ['rubberband', 'subtitles'];
// os ffmpeg estáticos do macOS não têm o rubberband: lá a troca de tom usa o asetrate/atempo (o worker detecta e escolhe sozinho)
export const filtersFor = (platform = process.platform) => (platform === 'darwin' ? FFMPEG_FILTERS.filter((name) => name !== 'rubberband') : FFMPEG_FILTERS);

const PY_IMPORTS = ['torch', 'torchaudio', 'demucs', 'stable_whisper', 'librosa', 'yt_dlp', 'audio_separator', 'onnxruntime', 'websockets', 'redis', 'langdetect'];

export const missingNames = (output, names) => names.filter((name) => !new RegExp(`\\b${name}\\b`).test(output));

/** Devolve { ok, checks: [{ name, ok, detail }] }; nunca levanta exceção por causa de um programa que falhou. */
export async function verifyEngine(root, { runImpl = run } = {}) {
  const p = paths(root);
  const env = launchEnv(root);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const checks = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error.message ?? error).slice(0, 400) });
    }
  };
  const exec = (command, args) => runImpl(command, args, { cwd: root, env });

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
    return (await exec(p.python, ['-I', '-c', code])).trim().split(/\r?\n/).pop();
  });
  await check('o aplicativo do worker inicia', async () => (await exec(p.python, ['-m', 'singalong_worker', '--version'])).trim());
  return { ok: checks.every((c) => c.ok), checks };
}
