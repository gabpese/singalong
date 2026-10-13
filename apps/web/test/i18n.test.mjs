import assert from 'node:assert/strict';
import test from 'node:test';
import en from '../src/i18n/en.js';
import es from '../src/i18n/es.js';
import { pickLanguage, translate } from '../src/i18n/index.js';
import pt from '../src/i18n/pt.js';

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('inglês e espanhol têm exatamente as chaves do português, com os mesmos {valores}', () => {
  for (const [name, catalog] of [['en', en], ['es', es]]) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(pt).sort(), `${name}: chaves diferentes do português`);
    for (const key of Object.keys(pt)) assert.equal(placeholders(catalog[key]), placeholders(pt[key]), `${name}: ${key}`);
  }
});

test('pickLanguage: a escolha salva vale; senão o idioma do navegador; senão o português', () => {
  assert.equal(pickLanguage('es', ['en-US']), 'es');
  assert.equal(pickLanguage(null, ['en-US', 'pt-BR']), 'en');
  assert.equal(pickLanguage(null, ['pt-PT']), 'pt-BR');
  assert.equal(pickLanguage(null, ['es-AR']), 'es');
  assert.equal(pickLanguage('xx', ['fr-FR']), 'pt-BR');
  assert.equal(pickLanguage(null, []), 'pt-BR');
});

test('translate troca os {valores}; sem tradução cai no português e depois na chave', () => {
  assert.equal(translate('en', 'queue.more', { n: 3 }), '+ 3 in the queue');
  assert.equal(translate('pt-BR', 'queue.more', { n: 3 }), '+ 3 na fila');
  assert.equal(translate('en', 'chave.que.nao.existe'), 'chave.que.nao.existe');
  assert.equal(translate('es', 'queue.more'), '+ {n} en la cola'); // sem valores: deixa o marcador
});

test('toda chave usada no código (t, tRich, translate) existe no catálogo', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'vendor' && name !== 'i18n') walk(path);
      } else if (/\.(tsx?|js)$/.test(name)) files.push(path);
    }
  };
  walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const missing = [];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:t|tRich|translate)\(\s*'([a-zA-Z0-9.]+)'/g)) {
      if (!(match[1] in pt)) missing.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
