/** Ícone SVG da interface (public/icons/*.svg), desenhado como máscara: herda a cor do texto ao redor. */
export type IconName = 'singing' | 'add-song' | 'musics' | 'link' | 'host' | 'display' | 'search' | 'minus' | 'plus' | 'pause' | 'resume' | 'next-song';

export function Icon({ name }: { name: IconName }) {
  return <span className={`icon i-${name}`} aria-hidden="true" />; // decorativo: o texto ao lado já diz o que é
}
