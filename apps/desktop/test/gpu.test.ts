// The window's video card choices: NVIDIA and AMD when they work, Apple's GPU only as a beta option, and the CPU always.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Gpu, HardwareInfo } from '../ui/bridge.ts';
import { engineInUse, gpuChoices, isAccelerated, kindOf, machineLine, offeredGpu } from '../ui/gpu.ts';

const nvidia = { name: 'NVIDIA GeForce RTX 3060', driver: '552.22', vram_mb: 12288, compute: '8.6', vendor: 'nvidia', engine: 'cu121' };
const amd = { name: 'AMD Radeon RX 7900 XTX', driver: 'amdgpu', vram_mb: 24560, compute: 'gfx1100', vendor: 'amd', engine: 'rocm6.2', access: true };
const apple = { name: 'Apple M2', driver: 'Metal', vram_mb: 16384, compute: 'mps', vendor: 'apple', engine: 'mps' };
const info = (engine: string, gpus: Gpu[], extra = {}): HardwareInfo => ({ engine, gpus, cpu_cores: 8, ram_mb: 16384, ...extra });
const values = (choices: ReturnType<typeof gpuChoices>) => choices.options.map(([value]) => value);

test("NVIDIA: the card's option shows and automatic recommends the card (as it always did)", () => {
  const choices = gpuChoices(info('cu121', [nvidia]), 'cu121');
  assert.deepEqual(values(choices), ['auto', 'cu121', 'cpu']);
  assert.equal(choices.options[0][1], 'Automático (recomendado: placa de vídeo)');
  assert.equal(choices.options[1][1], 'Placa de vídeo: NVIDIA GeForce RTX 3060');
  assert.equal(choices.wanted, 'cu121');
});

test('NVIDIA with an old driver: the card stays an option (the choice is the person\'s), but automatic recommends the processor', () => {
  const choices = gpuChoices(info('cpu', [nvidia]), 'cpu');
  assert.deepEqual(values(choices), ['auto', 'cu121', 'cpu']);
  assert.equal(choices.options[0][1], 'Automático (recomendado: processador)');
  assert.equal(choices.wanted, 'cpu');
});

test('AMD: a card ROCm accepts becomes an option and the recommended one; a card it does not accept does not', () => {
  const supported = gpuChoices(info('rocm6.2', [amd]), 'rocm6.2');
  assert.deepEqual(values(supported), ['auto', 'rocm6.2', 'cpu']);
  assert.equal(supported.options[0][1], 'Automático (recomendado: placa de vídeo)');
  assert.equal(supported.options[1][1], 'Placa de vídeo: AMD Radeon RX 7900 XTX');
  assert.equal(supported.wanted, 'rocm6.2');
  const rx6600 = { ...amd, name: 'AMD Radeon RX 6600', compute: 'gfx1032' };
  const unsupported = gpuChoices(info('cpu', [rx6600]), 'cpu'); // the reason shows in "Em uso"
  assert.deepEqual(values(unsupported), ['auto', 'cpu']);
});

test('Apple: the GPU is an option marked beta, automatic is the processor, and whoever chose it keeps it', () => {
  const choices = gpuChoices(info('cpu', [apple]), 'cpu');
  assert.deepEqual(values(choices), ['auto', 'mps', 'cpu']);
  assert.equal(choices.options[0][1], 'Automático (recomendado: processador)');
  assert.equal(choices.options[1][1], 'GPU da Apple (beta): Apple M2');
  assert.equal(choices.wanted, 'cpu');
  assert.equal(gpuChoices(info('cpu', [apple]), 'mps').wanted, 'mps');
});

test('no card at all (or the old worker, without a vendor): automatic and the processor; an NVIDIA card without a vendor still works', () => {
  assert.deepEqual(values(gpuChoices(info('cpu', []), 'cpu')), ['auto', 'cpu']);
  assert.deepEqual(values(gpuChoices(null, 'cpu')), ['auto', 'cpu']);
  const old = { name: 'NVIDIA GeForce GTX 1060', driver: '552.22', vram_mb: 6144, compute: '6.1' };
  assert.deepEqual(values(gpuChoices(info('cu121', [old]), 'cu121')), ['auto', 'cu121', 'cpu']);
  assert.equal(offeredGpu(info('cu121', [old])), old);
});

test("the engine in use and the computer's line", () => {
  assert.deepEqual(['cpu', 'cu121', 'rocm6.2', 'mps', undefined].map(isAccelerated), [false, true, true, true, false]);
  assert.deepEqual(['cpu', 'cu121', 'rocm6.2', 'mps', 'anything'].map(kindOf), ['cpu', 'cu121', 'rocm6.2', 'mps', 'cpu']);
  assert.deepEqual(['cpu', 'cu121', 'rocm6.2', 'mps'].map(engineInUse), ['processador', 'placa de vídeo', 'placa de vídeo', 'GPU da Apple (beta)']);
  assert.equal(machineLine(info('cu121', [nvidia]), nvidia), '8 núcleos · 16 GB de memória · NVIDIA GeForce RTX 3060 (driver 552.22)');
  assert.equal(machineLine(info('rocm6.2', [amd]), amd), '8 núcleos · 16 GB de memória · AMD Radeon RX 7900 XTX'); // without "driver amdgpu", which helps nobody
  assert.equal(machineLine(info('cpu', []), null), '8 núcleos · 16 GB de memória · sem placa de vídeo compatível');
  assert.equal(machineLine(null, null), '');
});
