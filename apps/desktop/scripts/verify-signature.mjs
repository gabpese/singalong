// Confere a assinatura (Authenticode) de um arquivo do Windows.
//   node scripts/verify-signature.mjs dist/singalong_karaoke.exe            → mostra e sai com erro se NÃO estiver assinado
//   node scripts/verify-signature.mjs <arquivo> --trusted                   → exige também que o Windows confie (certificado de verdade)
//   node scripts/verify-signature.mjs <arquivo> --expect-unsigned           → o contrário: falha se estiver assinado
// Um certificado de teste (autoassinado) aparece como "NotTrusted": assinado, mas o Windows não confia. É o esperado no CI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);

const STATUS = { 0: 'Valid', 1: 'UnknownError', 2: 'NotSigned', 3: 'HashMismatch', 4: 'NotTrusted', 5: 'NotSupportedFileFormat', 6: 'Incompatible' };

/** O JSON do Get-AuthenticodeSignature como um relatório simples. */
export function parseSignatureReport(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  const status = typeof raw.Status === 'number' ? STATUS[raw.Status] ?? String(raw.Status) : String(raw.Status ?? 'UnknownError');
  const cert = raw.SignerCertificate ?? null;
  return {
    status,
    signed: status !== 'NotSigned' && status !== 'NotSupportedFileFormat',
    trusted: status === 'Valid',
    subject: cert?.Subject ?? null,
    thumbprint: cert?.Thumbprint ?? null,
    timestamped: Boolean(raw.TimeStamperCertificate),
    message: raw.StatusMessage ?? '',
  };
}

export async function readSignature(file) {
  const script = `Get-AuthenticodeSignature -LiteralPath $args[0] | Select-Object Status, StatusMessage, @{n='SignerCertificate';e={ if ($_.SignerCertificate) { @{ Subject = $_.SignerCertificate.Subject; Thumbprint = $_.SignerCertificate.Thumbprint } } }}, @{n='TimeStamperCertificate';e={ $_.TimeStamperCertificate.Subject }} | ConvertTo-Json -Depth 4 -Compress`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} }`, file], { windowsHide: true, timeout: 60_000 });
  return parseSignatureReport(stdout);
}

/** Aplica as exigências: devolve a lista de problemas (vazia = tudo certo). */
export function judge(report, { trusted = false, expectUnsigned = false } = {}) {
  const problems = [];
  if (expectUnsigned) {
    if (report.signed) problems.push('o arquivo está assinado, mas deveria estar sem assinatura');
    return problems;
  }
  if (!report.signed) problems.push('o arquivo NÃO está assinado');
  else if (report.status === 'HashMismatch') problems.push('a assinatura não confere com o conteúdo (o arquivo foi alterado depois de assinado)');
  else if (!report.timestamped) problems.push('a assinatura não tem carimbo de hora: ela perderia a validade quando o certificado vencer');
  if (trusted && report.signed && !report.trusted) problems.push(`o Windows não confia nesta assinatura (${report.status})`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Uso: node scripts/verify-signature.mjs <arquivo> [--trusted | --expect-unsigned]');
    process.exit(2);
  }
  const report = await readSignature(file);
  console.log(`${file}\n  status: ${report.status}\n  assinado por: ${report.subject ?? '—'}\n  carimbo de hora: ${report.timestamped ? 'sim' : 'não'}`);
  const problems = judge(report, { trusted: process.argv.includes('--trusted'), expectUnsigned: process.argv.includes('--expect-unsigned') });
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(problems.length ? 1 : 0);
}
