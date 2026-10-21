// A fake "worker" for the controller's tests: it takes the same arguments and prints in the same format as the real one (whose
// lines the controller reads: "Conectado", "Pronto:", "erro:").
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const value = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
const mode = process.env.FAKE_MODE ?? '';

if (has('--consume')) {
  // with stdout in a pipe Node writes asynchronously: leaving before the write ends would lose the line (and the test was flaky)
  const leave = (code: number) => process.stdout.write('worker consuming\n', () => process.exit(code));
  if (mode === 'crash') leave(1);
  else if (mode === 'auth') leave(2);
  else {
    console.log('worker consuming');
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => process.exit(0));
  }
} else if (has('--hardware')) {
  console.log(JSON.stringify({ cpu_cores: 8, ram_mb: 16000, gpus: [], engine: 'cpu', reason: 'no card' }));
} else if (has('--youtube-status')) {
  console.log(mode === 'yt-out' ? 'Sem login válido.' : 'Conectado ao YouTube.');
} else if (has('--youtube-login')) {
  console.log(`Abrindo o navegador… ${value('--youtube-login') ?? 'default'}`);
  if (mode === 'yt-hang') setInterval(() => {}, 1000); // waits for the user to log in (the tests cancel)
  if (mode === 'yt-fail') {
    console.log('Tempo esgotado.');
    process.exit(1);
  }
  if (mode !== 'yt-hang') console.log('Conectado ao YouTube.');
} else if (has('--import')) {
  console.log(`importing ${value('--import')}`);
  if (mode === 'import-fail') {
    console.log('erro: o arquivo não é um áudio válido');
    process.exit(3);
  }
  console.log(`Pronto: ${value('--artist') ?? 'X'} - ${value('--title') ?? 'Y'}  (f-0123456789ab, letra: auto)`);
} else {
  console.log('args', args.join(' '));
}
