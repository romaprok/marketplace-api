#!/usr/bin/env node
// npm run scan — scan the image with Trivy and gate on a threshold that is
// computed: count the findings at the chosen severity, compare with SCAN_MAX,
// exit 0 or 1 accordingly. Nothing here prints a verdict it didn't count.
//
//   SCAN_MAX       how many findings are allowed (default: the working threshold below)
//   SCAN_SEVERITY  which severities count (default CRITICAL,HIGH)
//   SCAN_IMAGE     what to scan (default marketplace-api:hw28)
//
// Only fixable findings count: a gate on something nobody can fix yet only
// teaches people to ignore the gate.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The working threshold CI runs with: no fixable CRITICAL or HIGH at all (README).
const DEFAULT_MAX = 0;
const TRIVY_IMAGE = 'aquasec/trivy:0.67.2';

const image = process.env.SCAN_IMAGE ?? 'marketplace-api:hw28';
const severity = process.env.SCAN_SEVERITY ?? 'CRITICAL,HIGH';
const maxAllowed = Number(process.env.SCAN_MAX ?? DEFAULT_MAX);
if (!Number.isInteger(maxAllowed)) {
  console.error(`SCAN_MAX must be an integer, got "${process.env.SCAN_MAX}"`);
  process.exit(2);
}

// The image goes to Trivy as a tarball, so the scanner container needs no
// Docker socket. Its vulnerability DB is cached in a named volume.
const dir = mkdtempSync(join(tmpdir(), 'scan-'));
let report;
try {
  execFileSync('docker', ['save', '-o', join(dir, 'image.tar'), image]);
  const run = spawnSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${dir}:/scan`,
      '-v', 'trivy-cache:/root/.cache/trivy',
      TRIVY_IMAGE,
      'image', '--input', '/scan/image.tar',
      '--format', 'json', '--quiet',
      '--scanners', 'vuln',
      '--severity', severity,
      '--ignore-unfixed',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    console.error(`trivy failed (exit ${run.status}):\n${run.stderr}`);
    process.exit(2);
  }
  report = JSON.parse(run.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const findings = (report.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []);
const bySeverity = {};
for (const f of findings) bySeverity[f.Severity] = (bySeverity[f.Severity] ?? 0) + 1;
const found = findings.length;
const pass = found <= maxAllowed;

console.log(`image=${image}`);
console.log(`scanner=${TRIVY_IMAGE.split(':')[1]}`);
console.log(`severity=${severity}`);
for (const level of severity.split(',')) console.log(`found-${level.toLowerCase()}=${bySeverity[level] ?? 0}`);
console.log(`found=${found}`);
console.log(`max-allowed=${maxAllowed}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
for (const f of findings.slice(0, 10)) {
  console.error(`  ${f.Severity} ${f.VulnerabilityID} ${f.PkgName} ${f.InstalledVersion} -> ${f.FixedVersion}`);
}
process.exitCode = pass ? 0 : 1;
