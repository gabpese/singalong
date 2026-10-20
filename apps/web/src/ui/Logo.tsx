// O logotipo: "singalong" em duas tintas e, ao lado, a placa "AO VIVO" das portas de estúdio (gasta, mas funcionando: pisca de leve).
// Só entra onde a placa fica legível (a partir de uns 56 px de altura de letra); nos tamanhos pequenos vale a marca (/brand/mark.svg).
import { t } from '../i18n/index.ts';

export function Logo({ onPaper = false }: { onPaper?: boolean }) {
  const letters = [...t('brand.live')];
  const flicker = Math.min(3, letters.length - 1); // uma letra falha mais que as outras
  return (
    <span className={`logo${onPaper ? ' on-paper' : ''}`}>
      <span className="logo-word">singalong</span>
      <span className="logo-sign" aria-hidden="true">
        {letters.map((letter, index) => (
          <span key={index} className={index === flicker ? 'flick' : undefined}>
            {letter}
          </span>
        ))}
      </span>
    </span>
  );
}
