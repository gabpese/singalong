import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles/style.css', import.meta.url), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The selectors (the text before `{`) of the top-level rules, that is, outside @media. */
function topLevelSelectors(source: string) {
  const selectors: string[] = [];
  let depth = 0;
  let buffer = '';
  for (const ch of source) {
    if (ch === '{') {
      if (depth === 0) selectors.push(buffer.trim());
      depth++;
      buffer = '';
    } else if (ch === '}') {
      depth--;
      buffer = '';
    } else if (depth === 0) buffer += ch;
  }
  return selectors;
}

test('CSS: no simple class is defined twice (the same name on different screens collides)', () => {
  // It happened: `.singer` (the phone) inherited the display:grid of the TV's `.singer`; `.next` (a label) inherited the
  // lyrics' huge font; `.now` got the card's background. Each context needs its own name (e.g. .now-singer, .is-next).
  const counts = new Map<string, number>();
  for (const selector of topLevelSelectors(css)) {
    if (/^\.[a-z0-9-]+$/i.test(selector)) counts.set(selector, (counts.get(selector) ?? 0) + 1);
  }
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([selector]) => selector);
  assert.deepEqual(duplicated, []);
});

test('CSS: every .i-<name> icon points to a file that exists in public/icons', () => {
  const names = [...css.matchAll(/\.i-([a-z-]+)\s*\{\s*--icon:\s*url\('\/icons\/([a-z-]+\.svg)'\)/g)];
  assert.ok(names.length >= 7, `icons declared: ${names.length}`);
  for (const [, name, file] of names) {
    assert.equal(file, `${name}.svg`, `.i-${name} must point to ${name}.svg`);
    const svg = readFileSync(new URL(`../public/icons/${file}`, import.meta.url), 'utf-8');
    assert.match(svg, /<svg[\s\S]*<path /, `${file} must be an SVG with a drawing`);
  }
});

test('CSS: the hidden attribute always beats the display set by the classes', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});
