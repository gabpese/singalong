/** An interface SVG icon (public/icons/*.svg), drawn as a mask: it takes the color of the surrounding text. */
export type IconName = 'singing' | 'add-song' | 'musics' | 'link' | 'host' | 'display' | 'search' | 'minus' | 'plus' | 'pause' | 'resume' | 'next-song' | 'mic' | 'sound' | 'shuffle' | 'melody' | 'stage';

export function Icon({ name }: { name: IconName }) {
  return <span className={`icon i-${name}`} aria-hidden="true" />; // decorative: the text beside it already says what it is
}
