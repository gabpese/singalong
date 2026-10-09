import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles/style.css', import.meta.url), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Seletores (texto antes do `{`) das regras de nível de topo, ou seja, fora de @media. */
function topLevelSelectors(source) {
  const selectors = [];
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

test('CSS: nenhuma classe simples é definida duas vezes (nomes iguais em telas diferentes colidem)', () => {
  // Já aconteceu: `.singer` (celular) herdou o display:grid do `.singer` da TV; `.next` (etiqueta) herdou a fonte
  // gigante da letra; `.now` ganhou o fundo do card. Cada contexto precisa do seu nome (ex.: .now-singer, .is-next).
  const counts = new Map();
  for (const selector of topLevelSelectors(css)) {
    if (/^\.[a-z0-9-]+$/i.test(selector)) counts.set(selector, (counts.get(selector) ?? 0) + 1);
  }
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([selector]) => selector);
  assert.deepEqual(duplicated, []);
});

test('CSS: todo ícone .i-<nome> aponta para um arquivo que existe em public/icons', () => {
  const names = [...css.matchAll(/\.i-([a-z-]+)\s*\{\s*--icon:\s*url\('\/icons\/([a-z-]+\.svg)'\)/g)];
  assert.ok(names.length >= 7, `ícones declarados: ${names.length}`);
  for (const [, name, file] of names) {
    assert.equal(file, `${name}.svg`, `.i-${name} deve apontar para ${name}.svg`);
    const svg = readFileSync(new URL(`../public/icons/${file}`, import.meta.url), 'utf-8');
    assert.match(svg, /<svg[\s\S]*<path /, `${file} precisa ser um SVG com desenho`);
  }
});

test('CSS: o atributo hidden sempre vence os display definidos nas classes', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});
