import { PACKAGE_HOMEPAGE } from '#app/package-meta.js'
import type { Finding, Severity } from '#app/types.js'

/** SARIF has three levels; map ours onto them without inventing precision. */
function level(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium') return 'warning'
  return 'note'
}

const DESCRIPTIONS: Record<string, string> = {
  'phantom-api': 'Calls an API that does not exist — hallucinated method, property, or arity',
  'phantom-dep': 'Imports a package that is not a declared dependency',
  reinvented: 'Adds a callable whose token-identical implementation already existed in the same package',
  'dropped-guard': 'A guard present before the change is gone after it',
  'swallowed-error': 'Error handling that discards the failure',
  'vacuous-test': 'A test that asserts nothing, or mocks the unit under test',
  'assertion-drift': 'An expected value edited to match new output',
  'plausible-logic': 'Code that reads correctly but behaves incorrectly',
}

/**
 * SARIF 2.1.0 — the format GitHub code scanning ingests, which turns findings into
 * inline PR annotations. Only the fields consumers actually read are emitted.
 */
export function sarif(findings: Finding[]): string {
  const checks = [...new Set(findings.map((f) => f.check))].sort()

  const doc = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'PowerShot',
            informationUri: PACKAGE_HOMEPAGE,
            rules: checks.map((check) => ({
              id: check,
              name: check,
              shortDescription: { text: DESCRIPTIONS[check] ?? check },
              properties: {
                tags: [findings.find((f) => f.check === check)?.class ?? 'verified'],
              },
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.check,
          level: level(f.severity),
          message: {
            text: f.evidence ? f.title + ' (' + f.evidence.oracle + ': ' + f.evidence.detail + ')' : f.title,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: { startLine: f.line },
              },
            },
          ],
          properties: { class: f.class, confidence: f.confidence, severity: f.severity },
        })),
      },
    ],
  }
  return JSON.stringify(doc, null, 2) + '\n'
}
