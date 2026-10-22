// The QR code to join the Room: uses PUBLIC_URL (the address the phones reach) or the page's own.
import { useEffect, useState } from 'react';
import { t } from '../i18n/index.ts';
import { api } from '../lib/identity.ts';
import type { PublicConfig } from '../lib/types.ts';
import qrcode from '../vendor/qrcode/qrcode.mjs';

/** `compact`: the small card that stays on the TV while a song plays (without the written address). */
export function QrCode({ code, compact = false }: { code: string; compact?: boolean }) {
  const [join, setJoin] = useState<{ url: string; svg: string; localhostWarning: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let base = location.origin;
      let configured = false;
      try {
        const config = await api<PublicConfig>('GET', '/api/config');
        if (config.public_url) {
          base = config.public_url;
          configured = true;
        }
      } catch {
        // no config: uses the page's origin
      }
      const url = `${base}/room.html?room=${code}`;
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      if (!cancelled) {
        setJoin({
          url,
          svg: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }), // an SVG generated here, from our URL
          localhostWarning: !configured && ['localhost', '127.0.0.1'].includes(location.hostname),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <>
      <div className="qr" role="img" aria-label={t('tvp.qrAria')} dangerouslySetInnerHTML={{ __html: join?.svg ?? '' }} />
      <p className="hint" hidden={compact}>
        {join?.url}
        {join?.localhostWarning ? t('tvp.qrLocalhost') : ''}
      </p>
    </>
  );
}
