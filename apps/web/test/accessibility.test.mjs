import assert from 'node:assert/strict';
import test from 'node:test';
import { LYRICS_SCALES, stepScale } from '../src/lib/accessibility.js';

test('stepScale: anda pela lista e para nos extremos', () => {
  assert.equal(stepScale(1, 1), 1.25);
  assert.equal(stepScale(1, -1), 0.8);
  assert.equal(stepScale(LYRICS_SCALES.at(-1), 1), LYRICS_SCALES.at(-1));
  assert.equal(stepScale(LYRICS_SCALES[0], -1), LYRICS_SCALES[0]);
  assert.equal(stepScale(1.3, 1), 1.5); // valor fora da lista: parte do mais próximo
});

test('canInstallApp: só computador com Windows (não celular, tablet nem outros sistemas)', async () => {
  const { canInstallApp } = await import('../src/lib/platform.js');
  assert.equal(canInstallApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'), true);
  assert.equal(canInstallApp('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'), false);
  assert.equal(canInstallApp('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'), false);
  assert.equal(canInstallApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'), false);
  assert.equal(canInstallApp('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'), false);
  assert.equal(canInstallApp('Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1) Mobile Safari/537.36 Edge/14'), false);
  assert.equal(canInstallApp(undefined), false);
});
