// Como o instalador é assinado (Authenticode), escolhido pelo ambiente. Sem nenhuma variável, nada muda: sai sem assinatura,
// como sempre foi. Com um certificado, o instalador, o desinstalador e o programa saem assinados e carimbados com a hora.
//
//   Certificado em arquivo (.pfx/.p12), para uso local ou no CI com o arquivo guardado em um segredo:
//     CSC_LINK=<caminho do .pfx, ou o conteúdo em base64>   CSC_KEY_PASSWORD=<senha>
//   Azure Trusted Signing (a chave fica na nuvem da Microsoft; é o que funciona no CI sem token físico):
//     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (a identidade que assina) e
//     SINGALONG_AZURE_ENDPOINT, SINGALONG_AZURE_ACCOUNT, SINGALONG_AZURE_PROFILE, SINGALONG_PUBLISHER (o nome da empresa/pessoa do certificado)
//   Opcionais: SINGALONG_PUBLISHER (o nome do certificado, para o atualizador conferir quem assinou), SINGALONG_TIMESTAMP_URL
//   SINGALONG_REQUIRE_SIGNING=1 → se não houver como assinar, o build FALHA (para a versão de verdade).

const DEFAULT_TIMESTAMP = 'http://timestamp.digicert.com';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: 'none' | 'pfx' | 'azure', win: Record<string, unknown>, summary: string }}
 */
export function resolveSigning(env = process.env) {
  const publisher = (env.SINGALONG_PUBLISHER ?? '').trim();
  const timestamp = (env.SINGALONG_TIMESTAMP_URL ?? '').trim() || DEFAULT_TIMESTAMP;
  const required = env.SINGALONG_REQUIRE_SIGNING === '1';

  const azure = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'SINGALONG_AZURE_ENDPOINT', 'SINGALONG_AZURE_ACCOUNT', 'SINGALONG_AZURE_PROFILE'];
  const azureMissing = azure.filter((name) => !(env[name] ?? '').trim());
  if (azureMissing.length === 0) {
    if (!publisher) throw new Error('Assinatura pelo Azure Trusted Signing: falta SINGALONG_PUBLISHER (o nome do certificado, exatamente como nele).');
    return {
      mode: 'azure',
      summary: `Azure Trusted Signing (${env.SINGALONG_AZURE_ACCOUNT}/${env.SINGALONG_AZURE_PROFILE}), publicador "${publisher}"`,
      win: {
        signExecutable: true,
        forceCodeSigning: true,
        azureSignOptions: {
          publisherName: publisher,
          endpoint: env.SINGALONG_AZURE_ENDPOINT.trim(),
          codeSigningAccountName: env.SINGALONG_AZURE_ACCOUNT.trim(),
          certificateProfileName: env.SINGALONG_AZURE_PROFILE.trim(),
          timestampRfc3161: timestamp,
        },
      },
    };
  }
  // só uma parte das variáveis do Azure: provavelmente um engano, melhor avisar do que sair sem assinar em silêncio
  if (azureMissing.length < azure.length && !(env.CSC_LINK ?? '').trim()) {
    throw new Error(`Assinatura pelo Azure incompleta: faltam ${azureMissing.join(', ')}.`);
  }

  if ((env.CSC_LINK ?? '').trim()) {
    if (!(env.CSC_KEY_PASSWORD ?? '').trim()) throw new Error('CSC_LINK foi definido, mas falta CSC_KEY_PASSWORD (a senha do certificado).');
    return {
      mode: 'pfx',
      summary: `certificado em arquivo${publisher ? `, publicador "${publisher}"` : ''}`,
      win: {
        signExecutable: true,
        forceCodeSigning: true,
        signtoolOptions: {
          signingHashAlgorithms: ['sha256'],
          rfc3161TimeStampServer: timestamp,
          ...(publisher ? { publisherName: [publisher] } : {}),
        },
      },
    };
  }

  if (required) throw new Error('SINGALONG_REQUIRE_SIGNING=1, mas não há certificado: defina CSC_LINK e CSC_KEY_PASSWORD (ou as variáveis do Azure Trusted Signing).');
  return { mode: 'none', summary: 'sem assinatura (nenhum certificado configurado)', win: { signExecutable: false } };
}
