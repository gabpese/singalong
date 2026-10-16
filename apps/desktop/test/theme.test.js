// O app instalável usa uma cópia da ponte de tema do site (a CSP do app só aceita arquivos do próprio app): as duas têm de ser iguais.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const normalize = (text) => text.replace(/\r\n/g, '\n');

test('o theme-bridge.css do app é igual ao do site', async () => {
  assert.equal(normalize(await read('../ui/theme-bridge.css')), normalize(await read('../../web/src/styles/theme-bridge.css')));
});

test('as fontes do tema estão no app e a CSP as permite', async () => {
  const html = await read('../ui/index.html');
  assert.match(html, /font-src 'self'/);
  assert.match(html, /href="fonts.css"/);
  const css = await read('../ui/fonts.css');
  for (const file of ['geist-latin-wght-normal.woff2', 'bricolage-grotesque-latin-wght-normal.woff2']) {
    assert.ok(css.includes(file));
    assert.ok((await readFile(new URL(`../ui/fonts/${file}`, import.meta.url))).length > 10000);
  }
});

test('a interface do app carrega a ponte de tema antes do próprio estilo', async () => {
  const html = await read('../ui/index.html');
  assert.ok(html.indexOf('href="theme-bridge.css"') > -1);
  assert.ok(html.indexOf('href="theme-bridge.css"') < html.indexOf('href="style.css"'));
});

test('a marca (vinil com microfone) do app e a do site são a mesma de brand/mark.svg', async () => {
  const mark = normalize(await read('../../../brand/mark.svg'));
  assert.equal(normalize(await read('../ui/mark.svg')), mark);
  assert.equal(normalize(await read('../../web/public/brand/mark.svg')), mark);
});
