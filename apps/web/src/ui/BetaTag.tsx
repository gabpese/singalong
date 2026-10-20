// Marca "beta" ao lado dos recursos que ainda não são totalmente fiéis (pontuação e guia de melodia).
import { t } from '../i18n/index.ts';

export function BetaTag() {
  return (
    <span className="beta-tag" title={t('beta.note')}>
      {t('beta.tag')}
    </span>
  );
}
