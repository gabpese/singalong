import assert from 'node:assert/strict';
import test from 'node:test';
import { LYRICS_SCALES, stepScale } from '../src/lib/accessibility.ts';

test('stepScale: walks the list and stops at the ends', () => {
  assert.equal(stepScale(1, 1), 1.25);
  assert.equal(stepScale(1, -1), 0.8);
  assert.equal(stepScale(LYRICS_SCALES.at(-1)!, 1), LYRICS_SCALES.at(-1));
  assert.equal(stepScale(LYRICS_SCALES[0], -1), LYRICS_SCALES[0]);
  assert.equal(stepScale(1.3, 1), 1.5); // a value off the list: starts from the nearest
});

test('detectSystem and canInstallApp: Windows, macOS and Linux have an installer; phones, tablets and the rest do not', async () => {
  const { canInstallApp, detectSystem } = await import('../src/lib/platform.ts');
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'; // an M1 Mac says "Intel" too
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
  assert.equal(detectSystem(windows), 'windows');
  assert.equal(detectSystem(mac), 'macos');
  assert.equal(detectSystem(linux), 'linux');
  assert.equal(detectSystem('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'), 'phone'); // Android is Linux, but a phone
  assert.equal(detectSystem('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'), 'phone'); // "like Mac OS X" is not a Mac
  assert.equal(detectSystem('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'), 'phone');
  assert.equal(detectSystem('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'), 'phone'); // a Chromebook
  assert.equal(detectSystem('Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1) Mobile Safari/537.36 Edge/14'), 'phone');
  assert.equal(detectSystem('curl/8.0'), 'other');
  assert.equal(detectSystem(undefined), 'other');
  assert.deepEqual([windows, mac, linux, 'curl/8.0', undefined].map((agent) => canInstallApp(agent)), [true, true, true, false, false]);
});
