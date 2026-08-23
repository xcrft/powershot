import { createHash } from 'node:crypto'
import type { Finding, Severity } from '#app/types.js'

function level(s: Severity): string {
  return s === 'critical' ? 'blocker' : s === 'high' ? 'major' : s === 'medium' ? 'minor' : 'info'
}

/**
 * GitLab Code Quality — the format that renders findings inside a merge request
 * rather than in a job log. The fingerprint must be stable across runs, or GitLab
 * reports every finding as new on each pipeline.
 */
export function codeQuality(findings: Finding[]): string {
  return (
    JSON.stringify(
      findings.map((f) => ({
        description: f.title,
        check_name: f.check,
        fingerprint: createHash('sha1').update(f.check + f.file + f.line + f.title).digest('hex'),
        severity: level(f.severity),
        location: { path: f.file, lines: { begin: f.line } },
      })),
      null,
      2,
    ) + '\n'
  )
}
