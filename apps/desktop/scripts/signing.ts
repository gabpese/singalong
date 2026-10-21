// How the installer is signed (Authenticode), chosen by the environment. Without any variable nothing changes: it comes out
// unsigned, as it always did. With a certificate, the installer, the uninstaller and the program come out signed and time-stamped.
//
//   A certificate file (.pfx/.p12), for local use or in CI with the file kept in a secret:
//     CSC_LINK=<the .pfx's path, or its content in base64>   CSC_KEY_PASSWORD=<password>
//   Azure Trusted Signing (the key stays in Microsoft's cloud; it is what works in CI without a physical token):
//     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (the identity that signs) and
//     SINGALONG_AZURE_ENDPOINT, SINGALONG_AZURE_ACCOUNT, SINGALONG_AZURE_PROFILE, SINGALONG_PUBLISHER (the certificate's company or person)
//   Optional: SINGALONG_PUBLISHER (the certificate's name, so the updater checks who signed), SINGALONG_TIMESTAMP_URL
//   SINGALONG_REQUIRE_SIGNING=1 → when there is no way to sign, the build FAILS (for the real release).
import type { WindowsConfiguration } from 'electron-builder';

const DEFAULT_TIMESTAMP = 'http://timestamp.digicert.com';

export interface Signing {
  mode: 'none' | 'pfx' | 'azure';
  summary: string;
  /** electron-builder's `win` options. */
  win: WindowsConfiguration;
}

export function resolveSigning(env: Record<string, string | undefined> = process.env): Signing {
  const value = (name: string) => (env[name] ?? '').trim();
  const publisher = value('SINGALONG_PUBLISHER');
  const timestamp = value('SINGALONG_TIMESTAMP_URL') || DEFAULT_TIMESTAMP;
  const required = env.SINGALONG_REQUIRE_SIGNING === '1';

  const azure = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'SINGALONG_AZURE_ENDPOINT', 'SINGALONG_AZURE_ACCOUNT', 'SINGALONG_AZURE_PROFILE'];
  const azureMissing = azure.filter((name) => !value(name));
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
          endpoint: value('SINGALONG_AZURE_ENDPOINT'),
          codeSigningAccountName: value('SINGALONG_AZURE_ACCOUNT'),
          certificateProfileName: value('SINGALONG_AZURE_PROFILE'),
          timestampRfc3161: timestamp,
        },
      },
    };
  }
  // only some of Azure's variables: probably a mistake, better to warn than to come out unsigned in silence
  if (azureMissing.length < azure.length && !value('CSC_LINK')) {
    throw new Error(`Assinatura pelo Azure incompleta: faltam ${azureMissing.join(', ')}.`);
  }

  if (value('CSC_LINK')) {
    if (!value('CSC_KEY_PASSWORD')) throw new Error('CSC_LINK foi definido, mas falta CSC_KEY_PASSWORD (a senha do certificado).');
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
