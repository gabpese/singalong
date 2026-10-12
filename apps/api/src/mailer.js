// Envio de e-mail pela API HTTP do Brevo (https://developers.brevo.com/reference/sendtransacemail): sem biblioteca e sem SMTP
// (a Oracle bloqueia a porta de envio direto). O plano grátis do Brevo basta para códigos de pareamento.

/**
 * @param apiKey     a chave de API do Brevo (segredo: só no .env do servidor)
 * @param fromEmail  o remetente, já verificado no Brevo
 * @returns { enabled, send({ to, subject, text }) } — `send` levanta erro se o Brevo recusar.
 */
export function createMailer({ apiKey = '', fromEmail = '', fromName = 'Singalong', fetchImpl = fetch } = {}) {
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

/** O que a pessoa recebe. Só o código, o prazo e de onde veio: nada de link clicável (menos risco de phishing). */
export function pairingEmail({ code, minutes, server }) {
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
