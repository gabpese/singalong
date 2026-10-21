// How the installer is signed: the choice by the environment and reading the signature (without a real certificate).
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSigning } from '../scripts/signing.ts';
import { judge, parseSignatureReport, readSignature, type SignatureReport } from '../scripts/verify-signature.ts';

const AZURE = {
  AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's',
  SINGALONG_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net', SINGALONG_AZURE_ACCOUNT: 'account', SINGALONG_AZURE_PROFILE: 'profile', SINGALONG_PUBLISHER: 'Jane Doe',
};

test('without any variable: unsigned, as it always was', () => {
  const result = resolveSigning({});
  assert.equal(result.mode, 'none');
  assert.equal(result.win.signExecutable, false);
  assert.match(result.summary, /sem assinatura/);
});

test('a certificate file (CSC_LINK and its password): signs with sha256 and a time stamp, and requires the signature', () => {
  const result = resolveSigning({ CSC_LINK: 'C:/certs/singalong.pfx', CSC_KEY_PASSWORD: 'secret', SINGALONG_PUBLISHER: 'Jane Doe' });
  assert.equal(result.mode, 'pfx');
  assert.equal(result.win.signExecutable, true);
  assert.equal(result.win.forceCodeSigning, true);
  assert.deepEqual(result.win.signtoolOptions?.signingHashAlgorithms, ['sha256']);
  assert.match(result.win.signtoolOptions?.rfc3161TimeStampServer ?? '', /^https?:\/\//); // without a stamp the signature dies with the certificate
  assert.deepEqual(result.win.signtoolOptions?.publisherName, ['Jane Doe']);
  assert.equal(resolveSigning({ CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y', SINGALONG_TIMESTAMP_URL: 'http://tsa.example/ts' }).win.signtoolOptions?.rfc3161TimeStampServer, 'http://tsa.example/ts');
  assert.equal('publisherName' in (resolveSigning({ CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' }).win.signtoolOptions ?? {}), false); // without the name, the certificate's holds
  assert.throws(() => resolveSigning({ CSC_LINK: 'x' }), /CSC_KEY_PASSWORD/); // a missing password is an error, not an unsigned build
});

test("Azure Trusted Signing: needs every variable and the publisher's name", () => {
  const result = resolveSigning(AZURE);
  assert.equal(result.mode, 'azure');
  assert.deepEqual(result.win.azureSignOptions, {
    publisherName: 'Jane Doe', endpoint: 'https://eus.codesigning.azure.net', codeSigningAccountName: 'account', certificateProfileName: 'profile', timestampRfc3161: 'http://timestamp.digicert.com',
  });
  assert.throws(() => resolveSigning({ ...AZURE, SINGALONG_PUBLISHER: '' }), /SINGALONG_PUBLISHER/);
  assert.throws(() => resolveSigning({ ...AZURE, AZURE_CLIENT_SECRET: '' }), /AZURE_CLIENT_SECRET/); // half configured: it warns instead of coming out unsigned
});

test('SINGALONG_REQUIRE_SIGNING=1 fails the build without a certificate (and is harmless with one)', () => {
  assert.throws(() => resolveSigning({ SINGALONG_REQUIRE_SIGNING: '1' }), /não há certificado/);
  assert.equal(resolveSigning({ SINGALONG_REQUIRE_SIGNING: '1', CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' }).mode, 'pfx');
  assert.equal(resolveSigning({ SINGALONG_REQUIRE_SIGNING: '0' }).mode, 'none');
});

test("parseSignatureReport reads Get-AuthenticodeSignature (the status's number or name)", () => {
  const valid = parseSignatureReport({ Status: 0, SignerCertificate: { Subject: 'CN=Jane', Thumbprint: 'AB12' }, TimeStamperCertificate: 'CN=DigiCert' });
  assert.deepEqual([valid.status, valid.signed, valid.trusted, valid.subject, valid.timestamped], ['Valid', true, true, 'CN=Jane', true]);
  const selfSigned = parseSignatureReport('{"Status":"NotTrusted","SignerCertificate":{"Subject":"CN=Test"},"TimeStamperCertificate":"CN=TSA"}');
  assert.deepEqual([selfSigned.status, selfSigned.signed, selfSigned.trusted], ['NotTrusted', true, false]);
  const unsigned = parseSignatureReport({ Status: 2, SignerCertificate: null, TimeStamperCertificate: null });
  assert.deepEqual([unsigned.status, unsigned.signed, unsigned.subject], ['NotSigned', false, null]);
});

test('judge: signed and time-stamped passes; unsigned, unstamped, tampered or (when required) untrusted does not', () => {
  const report = (over: Partial<SignatureReport>): SignatureReport => ({ status: 'Valid', signed: true, trusted: true, timestamped: true, subject: 'CN=X', thumbprint: null, failed: false, message: '', ...over });
  assert.deepEqual(judge(report({})), []);
  assert.deepEqual(judge(report({ status: 'NotTrusted', trusted: false })), []); // a test certificate: signed, only Windows does not trust it
  assert.match(judge(report({ status: 'NotTrusted', trusted: false }), { trusted: true })[0], /não confia/);
  assert.match(judge(report({ status: 'NotSigned', signed: false }))[0], /NÃO está assinado/);
  assert.match(judge(report({ timestamped: false }))[0], /carimbo/);
  assert.match(judge(report({ status: 'HashMismatch', trusted: false }))[0], /não confere/);
  assert.deepEqual(judge(report({ status: 'NotSigned', signed: false }), { expectUnsigned: true }), []);
  assert.match(judge(report({}), { expectUnsigned: true })[0], /deveria estar sem assinatura/);
});

test('a file that cannot be read becomes a clear error (not a "signed without a stamp")', async () => {
  const report = parseSignatureReport({ Status: 'UnknownError', Error: true, StatusMessage: 'Cannot find path' });
  assert.equal(report.failed, true);
  assert.match(judge(report)[0], /não consegui ler a assinatura: Cannot find path/);
  assert.match(judge(report, { expectUnsigned: true })[0], /não consegui ler/); // not even as "expected unsigned"
  if (process.platform === 'win32') {
    const real = await readSignature('C:/path/that/does/not/exist.exe'); // the real PowerShell answers the error in JSON
    assert.equal(real.failed, true);
  }
});
