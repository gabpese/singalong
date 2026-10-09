// Ícones SVG da interface (public/icons/*.svg), desenhados como máscara: herdam a cor do texto ao redor.
// Nomes: singing, add-song, musics, link, host, display, search. O CSS (.i-<nome>) aponta cada um para o seu arquivo.

/** <span class="icon i-singing"></span>, pronto para entrar em qualquer elemento. */
export function icon(name) {
  const el = document.createElement('span');
  el.className = `icon i-${name}`;
  el.setAttribute('aria-hidden', 'true'); // decorativo: o texto ao lado já diz o que é
  return el;
}

/** Nome da pessoa com o ícone de cantor na frente (TV e fila). */
export function singerLabel(name) {
  const fragment = document.createDocumentFragment();
  fragment.append(icon('singing'), document.createTextNode(` ${name}`));
  return fragment;
}
