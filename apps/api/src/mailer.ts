// E-mail through Brevo's HTTP API (https://developers.brevo.com/reference/sendtransacemail): no library and no SMTP (Oracle
// blocks the port for sending directly). Brevo's free plan is enough for pairing codes.

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  enabled: boolean;
  /** Throws when Brevo refuses it. */
  send(mail: Mail): Promise<void>;
}

/**
 * `apiKey` is Brevo's API key (a secret: only in the server's .env); `fromEmail` is the sender, already verified in Brevo.
 * Without both, the mailer is off.
 */
export function createMailer({ apiKey = '', fromEmail = '', fromName = 'Singalong', fetchImpl = fetch }: { apiKey?: string; fromEmail?: string; fromName?: string; fetchImpl?: typeof fetch } = {}): Mailer {
  const enabled = Boolean(apiKey && fromEmail);
  return {
    enabled,
    async send({ to, subject, text }) {
      if (!enabled) throw new Error('O envio de e-mail não está configurado.');
      const response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { email: fromEmail, name: fromName }, to: [{ email: to }], subject, textContent: text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`O Brevo recusou o envio (${response.status}).`);
    },
  };
}

/** What the person receives. Only the code, how long it lasts and where it came from: no link to click (less risk of phishing). */
export function pairingEmail({ code, minutes, server }: { code: string; minutes: number; server: string }): Omit<Mail, 'to'> {
  return {
    subject: `Seu código do Singalong: ${code}`,
    text: [
      'Olá!',
      '',
      `Seu código para conectar o aplicativo Singalong Karaoke é: ${code}`,
      '',
      `Digite esse código no aplicativo. Ele vale por ${minutes} minutos e só pode ser usado uma vez.`,
      server ? `Servidor: ${server}` : '',
      '',
      'Se você não pediu este código, pode ignorar esta mensagem: ninguém consegue entrar sem ele.',
    ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n'),
  };
}
