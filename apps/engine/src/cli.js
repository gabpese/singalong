#!/usr/bin/env node
// Uso (o app de interface chama as mesmas funções; esta linha de comando serve para testar e para quem quiser montar à mão):
//   node src/cli.js assemble --dir C:\caminho\motor [--engine auto|cpu|cu121|rocm6.2|mps]
//   node src/cli.js verify   --dir C:\caminho\motor
//   node src/cli.js status   --dir C:\caminho\motor
import { assemble } from './assemble.js';
import { readState } from './engine.js';
import { verifyEngine } from './verify.js';

const args = process.argv.slice(2);
const command = args.shift();
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = option('dir', process.env.SINGALONG_ENGINE_DIR ?? '');

if (!['assemble', 'verify', 'status'].includes(command) || !root) {
  console.error('uso: node src/cli.js assemble|verify|status --dir PASTA [--engine auto|cpu|cu121|rocm6.2|mps]');
  process.exit(2);
}

if (command === 'assemble') {
  let lastLabel = '';
  let lastPercent = -10;
  const state = await assemble({
    root,
    engine: option('engine', 'auto'),
    onProgress: ({ label, done, total, line }) => {
      if (total) {
        const percent = Math.floor((done / total) * 100);
        if (percent >= lastPercent + 10 || label !== lastLabel) console.log(`${label}: ${percent}%`);
        lastPercent = percent;
      } else if (label !== lastLabel) {
        console.log(label);
      } else if (line && process.env.VERBOSE) {
        console.log(`  ${line}`);
      }
      lastLabel = label;
    },
  });
  console.log(`Motor: ${state.engine} (${state.fallback_reason ?? state.engine_reason}); torch ${state.torch_installed}`);
} else if (command === 'status') {
  console.log(JSON.stringify(await readState(root), null, 2));
} else {
  const report = await verifyEngine(root);
  for (const c of report.checks) console.log(`${c.ok ? 'OK    ' : 'FALHOU'} ${c.name}: ${c.detail}`);
  process.exit(report.ok ? 0 : 1);
}
