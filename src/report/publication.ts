import type { Finding } from '#app/types.js'

/**
 * Formats consumed as review annotations publish only agent claims strong enough
 * for action. Tentative suspicions remain in JSON, terminal, sessions, and caches
 * so they can be inspected without presenting them as review findings.
 */
export function publishableFindings(findings: Finding[]): Finding[] {
  return findings.filter((finding) =>
    finding.class !== 'judged' || finding.confidence !== 'tentative',
  )
}
