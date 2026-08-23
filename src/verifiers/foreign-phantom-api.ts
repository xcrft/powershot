import { join } from 'node:path'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { pyrightAvailable, pyrightDiagnostics } from '#app/lang/pyright.js'

/** An API the generated code invented, in Python. */
export const foreignPhantomApi: Verifier = {
  name: 'phantom-api',
  needs: ['python-types'],
  run(g: Ground): Finding[] {
    const python = g.foreign.filter((f) => f.pack.name === 'python')
    if (python.length === 0) return []
    if (!pyrightAvailable(g.root)) return [] // no oracle, no claim

    const byAbsolute = new Map(python.map((f) => [join(g.root, f.path), f]))
    const diagnostics = pyrightDiagnostics(g.root, [...byAbsolute.keys()])

    const findings: Finding[] = []
    for (const d of diagnostics) {
      const file = byAbsolute.get(d.file)
      if (!file || !file.changed.added.has(d.line)) continue

      findings.push({
        id: '',
        class: 'verified',
        check: 'phantom-api',
        severity: 'high',
        confidence: 'proven',
        file: file.path,
        line: d.line,
        span: { column: d.column, length: 1 },
        title: d.message,
        evidence: { oracle: 'pyright', detail: d.rule + ': ' + d.meaning },
      })
    }
    return findings
  },
}
