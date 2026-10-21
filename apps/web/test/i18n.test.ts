import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../src/i18n/en.ts';
import es from '../src/i18n/es.ts';
import { pickLanguage, translate } from '../src/i18n/index.ts';
import pt from '../src/i18n/pt.ts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('English and Spanish have exactly the Portuguese keys, with the same {values}', () => {
  for (const [name, catalog] of [['en', en], ['es', es]] as const) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(pt).sort(), `${name}: keys differ from the Portuguese`);
    for (const key of Object.keys(pt) as (keyof typeof pt)[]) assert.equal(placeholders(catalog[key]), placeholders(pt[key]), `${name}: ${key}`);
  }
});

test("pickLanguage: the saved choice wins; otherwise the browser's language; otherwise Portuguese", () => {
  assert.equal(pickLanguage('es', ['en-US']), 'es');
  assert.equal(pickLanguage(null, ['en-US', 'pt-BR']), 'en');
  assert.equal(pickLanguage(null, ['pt-PT']), 'pt-BR');
  assert.equal(pickLanguage(null, ['es-AR']), 'es');
  assert.equal(pickLanguage('xx', ['fr-FR']), 'pt-BR');
  assert.equal(pickLanguage(null, []), 'pt-BR');
});

test('translate fills the {values}; without a translation it falls back to Portuguese and then to the key', () => {
  assert.equal(translate('en', 'queue.more', { n: 3 }), '+ 3 in the queue');
  assert.equal(translate('pt-BR', 'queue.more', { n: 3 }), '+ 3 na fila');
  assert.equal(translate('en', 'key.that.does.not.exist'), 'key.that.does.not.exist');
  assert.equal(translate('es', 'queue.more'), '+ {n} en la cola'); // without values: it keeps the placeholder
});

test('every key the code uses (t, tRich, translate) exists in the catalog', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'vendor' && name !== 'i18n') walk(path);
      } else if (/\.(tsx?|js)$/.test(name)) files.push(path);
    }
  };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  const missing: string[] = [];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:t|tRich|translate)\(\s*'([a-zA-Z0-9.]+)'/g)) {
      if (!(match[1] in pt)) missing.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
