// The installable app uses a copy of the site's theme bridge (the app's CSP accepts only the app's own files): the two must match.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
const normalize = (text: string) => text.replace(/\r\n/g, '\n');

test("the app's theme-bridge.css matches the site's", async () => {
  assert.equal(normalize(await read('../ui/theme-bridge.css')), normalize(await read('../../web/src/styles/theme-bridge.css')));
});

test("the theme's fonts are in the app and the CSP allows them", async () => {
  const html = await read('../ui/index.html');
  assert.match(html, /font-src 'self'/);
  assert.match(html, /href="fonts.css"/);
  const css = await read('../ui/fonts.css');
  for (const file of ['geist-latin-wght-normal.woff2', 'bricolage-grotesque-latin-wght-normal.woff2']) {
    assert.ok(css.includes(file));
    assert.ok((await readFile(new URL(`../ui/fonts/${file}`, import.meta.url))).length > 10000);
  }
});

test("the app's window loads the theme bridge before its own style", async () => {
  const html = await read('../ui/index.html');
  assert.ok(html.indexOf('href="theme-bridge.css"') > -1);
  assert.ok(html.indexOf('href="theme-bridge.css"') < html.indexOf('href="style.css"'));
});

test("the app's and the site's mark (the vinyl with a microphone) are the same as brand/mark.svg", async () => {
  const mark = normalize(await read('../../../brand/mark.svg'));
  assert.equal(normalize(await read('../ui/mark.svg')), mark);
  assert.equal(normalize(await read('../../web/public/brand/mark.svg')), mark);
});
