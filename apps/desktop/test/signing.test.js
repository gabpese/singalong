// Como o instalador é assinado: a escolha pelo ambiente e a leitura da assinatura (sem precisar de um certificado de verdade).
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSigning } from '../scripts/signing.mjs';
import { judge, parseSignatureReport } from '../scripts/verify-signature.mjs';

const AZURE = {
  AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's',
  SINGALONG_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net', SINGALONG_AZURE_ACCOUNT: 'conta', SINGALONG_AZURE_PROFILE: 'perfil', SINGALONG_PUBLISHER: 'Fulano de Tal',
};

test('sem nenhuma variável: sem assinatura, como sempre foi', () => {
  const result = resolveSigning({});
  assert.equal(result.mode, 'none');
  assert.equal(result.win.signExecutable, false);
  assert.match(result.summary, /sem assinatura/);
});

test('certificado em arquivo (CSC_LINK + senha): assina com sha256, carimbo de hora e exige a assinatura', () => {
  const result = resolveSigning({ CSC_LINK: 'C:/certs/singalong.pfx', CSC_KEY_PASSWORD: 'segredo', SINGALONG_PUBLISHER: 'Fulano de Tal' });
  assert.equal(result.mode, 'pfx');
  assert.equal(result.win.signExecutable, true);
  assert.equal(result.win.forceCodeSigning, true);
  assert.deepEqual(result.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
  assert.match(result.win.signtoolOptions.rfc3161TimeStampServer, /^https?:\/\//); // sem carimbo a assinatura morre com o certificado
  assert.deepEqual(result.win.signtoolOptions.publisherName, ['Fulano de Tal']);
  assert.equal(resolveSigning({ CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y', SINGALONG_TIMESTAMP_URL: 'http://tsa.example/ts' }).win.signtoolOptions.rfc3161TimeStampServer, 'http://tsa.example/ts');
  assert.equal('publisherName' in resolveSigning({ CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' }).win.signtoolOptions, false); // sem o nome, vale o do certificado
  assert.throws(() => resolveSigning({ CSC_LINK: 'x' }), /CSC_KEY_PASSWORD/); // a senha faltando é um erro, não um build sem assinatura
});

test('Azure Trusted Signing: precisa de todas as variáveis e do nome do publicador', () => {
  const result = resolveSigning(AZURE);
  assert.equal(result.mode, 'azure');
  assert.deepEqual(result.win.azureSignOptions, {
    publisherName: 'Fulano de Tal', endpoint: 'https://eus.codesigning.azure.net', codeSigningAccountName: 'conta', certificateProfileName: 'perfil', timestampRfc3161: 'http://timestamp.digicert.com',
  });
  assert.throws(() => resolveSigning({ ...AZURE, SINGALONG_PUBLISHER: '' }), /SINGALONG_PUBLISHER/);
  assert.throws(() => resolveSigning({ ...AZURE, AZURE_CLIENT_SECRET: '' }), /AZURE_CLIENT_SECRET/); // meio configurado: avisa em vez de sair sem assinar
});

test('SINGALONG_REQUIRE_SIGNING=1 faz o build falhar sem certificado (e não atrapalha quando há)', () => {
  assert.throws(() => resolveSigning({ SINGALONG_REQUIRE_SIGNING: '1' }), /não há certificado/);
  assert.equal(resolveSigning({ SINGALONG_REQUIRE_SIGNING: '1', CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' }).mode, 'pfx');
  assert.equal(resolveSigning({ SINGALONG_REQUIRE_SIGNING: '0' }).mode, 'none');
});

test('parseSignatureReport lê o Get-AuthenticodeSignature (número ou nome do status)', () => {
  const valid = parseSignatureReport({ Status: 0, SignerCertificate: { Subject: 'CN=Fulano', Thumbprint: 'AB12' }, TimeStamperCertificate: 'CN=DigiCert' });
  assert.deepEqual([valid.status, valid.signed, valid.trusted, valid.subject, valid.timestamped], ['Valid', true, true, 'CN=Fulano', true]);
  const selfSigned = parseSignatureReport('{"Status":"NotTrusted","SignerCertificate":{"Subject":"CN=Teste"},"TimeStamperCertificate":"CN=TSA"}');
  assert.deepEqual([selfSigned.status, selfSigned.signed, selfSigned.trusted], ['NotTrusted', true, false]);
  const unsigned = parseSignatureReport({ Status: 2, SignerCertificate: null, TimeStamperCertificate: null });
  assert.deepEqual([unsigned.status, unsigned.signed, unsigned.subject], ['NotSigned', false, null]);
});

test('judge: assinado e carimbado passa; sem assinatura, sem carimbo, adulterado ou (se exigido) sem confiança, não', () => {
  const report = (over) => ({ status: 'Valid', signed: true, trusted: true, timestamped: true, subject: 'CN=X', ...over });
  assert.deepEqual(judge(report({})), []);
  assert.deepEqual(judge(report({ status: 'NotTrusted', trusted: false })), []); // certificado de teste: assinado, só o Windows não confia
  assert.match(judge(report({ status: 'NotTrusted', trusted: false }), { trusted: true })[0], /não confia/);
  assert.match(judge(report({ status: 'NotSigned', signed: false }))[0], /NÃO está assinado/);
  assert.match(judge(report({ timestamped: false }))[0], /carimbo/);
  assert.match(judge(report({ status: 'HashMismatch', trusted: false }))[0], /não confere/);
  assert.deepEqual(judge(report({ status: 'NotSigned', signed: false }), { expectUnsigned: true }), []);
  assert.match(judge(report({}), { expectUnsigned: true })[0], /deveria estar sem assinatura/);
});

test('um arquivo que não dá para ler vira um erro claro (não um "assinado sem carimbo")', async () => {
  const { readSignature } = await import('../scripts/verify-signature.mjs');
  const report = parseSignatureReport({ Status: 'UnknownError', Error: true, StatusMessage: 'Cannot find path' });
  assert.equal(report.failed, true);
  assert.match(judge(report)[0], /não consegui ler a assinatura: Cannot find path/);
  assert.match(judge(report, { expectUnsigned: true })[0], /não consegui ler/); // nem como "esperado sem assinatura"
  if (process.platform === 'win32') {
    const real = await readSignature('C:/caminho/que/nao/existe.exe'); // o PowerShell de verdade devolve o erro em JSON
    assert.equal(real.failed, true);
  }
});
