// QR code para entrar na sala: usa PUBLIC_URL (o endereço que os celulares alcançam) ou o da própria página.
import { useEffect, useState } from 'react';
import { api } from '../lib/identity.js';
import qrcode from '../vendor/qrcode/qrcode.mjs';

export function QrCode({ code }: { code: string }) {
  const [join, setJoin] = useState<{ url: string; svg: string; localhostWarning: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let base = location.origin;
      let configured = false;
      try {
        const config = await api('GET', '/api/config');
        if (config.public_url) {
          base = config.public_url;
          configured = true;
        }
      } catch {
        // sem config: usa a origem da página
      }
      const url = `${base}/room.html?room=${code}`;
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      if (!cancelled) {
        setJoin({
          url,
          svg: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }), // SVG gerado aqui, a partir da nossa URL
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
      <div className="qr" aria-label="QR code para entrar na sala" dangerouslySetInnerHTML={{ __html: join?.svg ?? '' }} />
      <p className="hint">
        {join?.url}
        {join?.localhostWarning ? '  —  para o QR funcionar nos celulares, defina PUBLIC_URL (ex.: http://192.168.0.10:3000)' : ''}
      </p>
    </>
  );
}
