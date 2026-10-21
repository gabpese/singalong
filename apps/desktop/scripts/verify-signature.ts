// Checks a Windows file's signature (Authenticode).
//   node scripts/verify-signature.ts dist/singalong_karaoke.exe            → shows it and exits with an error if it is NOT signed
//   node scripts/verify-signature.ts <file> --trusted                       → also requires Windows to trust it (a real certificate)
//   node scripts/verify-signature.ts <file> --expect-unsigned               → the opposite: fails if it is signed
// A test certificate (self-signed) shows as "NotTrusted": signed, but Windows does not trust it. That is expected in CI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);

const STATUS: Record<number, string> = { 0: 'Valid', 1: 'UnknownError', 2: 'NotSigned', 3: 'HashMismatch', 4: 'NotTrusted', 5: 'NotSupportedFileFormat', 6: 'Incompatible' };

/** What Get-AuthenticodeSignature answers, as the script below writes it in JSON. */
interface RawSignature {
  Status?: number | string;
  StatusMessage?: string;
  SignerCertificate?: { Subject?: string; Thumbprint?: string } | null;
  TimeStamperCertificate?: string | null;
  Error?: boolean;
}

export interface SignatureReport {
  status: string;
  signed: boolean;
  trusted: boolean;
  subject: string | null;
  thumbprint: string | null;
  timestamped: boolean;
  /** PowerShell could not even read the file (missing, no permission...). */
  failed: boolean;
  message: string;
}

/** Get-AuthenticodeSignature's JSON as a simple report. */
export function parseSignatureReport(json: string | RawSignature): SignatureReport {
  const raw: RawSignature = typeof json === 'string' ? JSON.parse(json) : json;
  const status = typeof raw.Status === 'number' ? STATUS[raw.Status] ?? String(raw.Status) : String(raw.Status ?? 'UnknownError');
  const cert = raw.SignerCertificate ?? null;
  return {
    status,
    signed: status !== 'NotSigned' && status !== 'NotSupportedFileFormat',
    trusted: status === 'Valid',
    subject: cert?.Subject ?? null,
    thumbprint: cert?.Thumbprint ?? null,
    timestamped: Boolean(raw.TimeStamperCertificate),
    failed: Boolean(raw.Error),
    message: raw.StatusMessage ?? '',
  };
}

/** The PowerShell script, with the path already escaped (single quotes doubled). It always answers JSON, even when something goes wrong. */
export function signatureScript(file: string): string {
  const path = String(file).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $sig = Get-AuthenticodeSignature -LiteralPath '${path}'`,
    '  $out = [ordered]@{ Status = [string]$sig.Status; StatusMessage = [string]$sig.StatusMessage; SignerCertificate = $null; TimeStamperCertificate = $null }',
    '  if ($sig.SignerCertificate) { $out.SignerCertificate = @{ Subject = [string]$sig.SignerCertificate.Subject; Thumbprint = [string]$sig.SignerCertificate.Thumbprint } }',
    '  if ($sig.TimeStamperCertificate) { $out.TimeStamperCertificate = [string]$sig.TimeStamperCertificate.Subject }',
    '  $out | ConvertTo-Json -Depth 4 -Compress',
    '} catch {',
    "  @{ Status = 'UnknownError'; Error = $true; StatusMessage = [string]$_.Exception.Message; SignerCertificate = $null; TimeStamperCertificate = $null } | ConvertTo-Json -Compress",
    '}',
  ].join('\n');
}

/**
 * Reads a file's signature. The script goes encoded (UTF-16 in base64): no quote of the path passes through the shell.
 * `powershell.exe` (5.1) inherits PowerShell 7's PSModulePath when the build runs inside it (as on GitHub's runners) and then
 * cannot load the security module: so the variable is cleared for it; if it still fails, it tries `pwsh`.
 */
export async function readSignature(file: string): Promise<SignatureReport> {
  const encoded = Buffer.from(signatureScript(file), 'utf16le').toString('base64');
  const { PSModulePath: _ignored, ...cleanEnv } = process.env;
  let last: SignatureReport | null = null;
  let problem = '';
  for (const [shell, env] of [['powershell.exe', cleanEnv], ['pwsh', process.env]] as const) {
    let stdout = '';
    try {
      ({ stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env }));
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      problem = `${shell}: ${failure.stderr || failure.message}`;
      continue; // missing or failed: try the other one
    }
    const text = stdout.trim().replace(/^﻿/, '');
    if (!text) {
      problem = `${shell}: não devolveu nada`;
      continue;
    }
    const report = parseSignatureReport(text);
    if (!report.failed) return report;
    last = report; // PowerShell answered but could not read: try the other one before giving up
  }
  if (last) return last;
  throw new Error(`Não consegui ler a assinatura de ${file}. ${problem.trim()}`);
}

/** Applies the requirements: answers the list of problems (empty = all good). */
export function judge(report: SignatureReport, { trusted = false, expectUnsigned = false } = {}): string[] {
  const problems: string[] = [];
  if (report.failed) return [`não consegui ler a assinatura: ${report.message}`];
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
    console.error('Uso: node scripts/verify-signature.ts <arquivo> [--trusted | --expect-unsigned]');
    process.exit(2);
  }
  const report = await readSignature(file);
  console.log(`${file}\n  status: ${report.status}\n  assinado por: ${report.subject ?? '—'}\n  carimbo de hora: ${report.timestamped ? 'sim' : 'não'}`);
  const problems = judge(report, { trusted: process.argv.includes('--trusted'), expectUnsigned: process.argv.includes('--expect-unsigned') });
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(problems.length ? 1 : 0);
}
