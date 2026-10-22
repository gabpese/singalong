// The "beta" tag beside the features that are not fully accurate yet (scoring and the melody guide).
import { t } from '../i18n/index.ts';

export function BetaTag() {
  return (
    <span className="beta-tag" title={t('beta.note')}>
      {t('beta.tag')}
    </span>
  );
}
