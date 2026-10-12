// Um "worker" de mentira para os testes do controlador: entende os mesmos argumentos e imprime o mesmo formato de saída.
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => args[args.indexOf(flag) + 1];
const mode = process.env.FAKE_MODE ?? '';

if (has('--consume')) {
  console.log('worker consumindo');
  if (mode === 'crash') process.exit(1);
  if (mode === 'auth') process.exit(2);
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
} else if (has('--create-room')) {
  if (mode === 'room-fail') {
    console.log('erro: não consegui falar com o servidor');
    process.exit(4);
  }
  console.log(JSON.stringify({ code: 'AB12', host_token: 'tok-anfitriao' }));
  console.log(`TV: ${value('--public-url')}/tv.html?room=AB12`);
} else if (has('--hardware')) {
  console.log(JSON.stringify({ cpu_cores: 8, ram_mb: 16000, gpus: [], engine: 'cpu', reason: 'sem placa' }));
} else if (has('--youtube-status')) {
  console.log(mode === 'yt-out' ? 'Sem login válido.' : 'Conectado ao YouTube.');
} else if (has('--youtube-login')) {
  console.log('Abrindo o navegador…');
  if (mode === 'yt-fail') {
    console.log('Tempo esgotado.');
    process.exit(1);
  }
  console.log('Conectado ao YouTube.');
} else if (has('--import')) {
  console.log(`importando ${value('--import')}`);
  if (mode === 'import-fail') {
    console.log('erro: o arquivo não é um áudio válido');
    process.exit(3);
  }
  console.log(`Pronto: ${value('--artist') ?? 'X'} - ${value('--title') ?? 'Y'}  (f-0123456789ab, letra: auto)`);
} else {
  console.log('args', args.join(' '));
}
