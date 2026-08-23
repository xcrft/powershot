import type { DiagnosticMessageChain } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

/**
 * Compiler diagnostics that mean "the code refers to something that does not exist".
 * Deliberately excludes 2307 (cannot find module) — phantom-dep owns that, so the
 * same defect is never reported twice.
 */
const HALLUCINATION_CODES = new Map<number, string>([
  [2339, 'property does not exist on type'],
  [2551, 'property does not exist on type (close match suggested)'],
  [2554, 'wrong number of arguments'],
  [2555, 'wrong number of arguments'],
  [2724, 'module has no exported member'],
  [2694, 'namespace has no exported member'],
])

/**
 * The checker often knows the right answer: "did you mean 'toUpperCase'?". Where it
 * does, the finding carries an exact replacement rather than advice, which a review
 * host can render as a one-click suggestion.
 */
function suggestedName(message: string): string | undefined {
  return /Did you mean '([^']+)'\?/.exec(message)?.[1]
}

/*
 * "Cannot find name" (TS2304/2552) is deliberately absent. Bench showed it firing on
 * `chrome` in a browser-extension package and on test-runner globals — it reports an
 * incompletely resolved project, not an invented API, and in a monorepo that is the
 * normal state when one root project spans many packages. The codes that really do
 * mean "this does not exist" are the property and arity ones kept above.
 */

/** A diagnostic message is either a string or a nested chain — flatten it to one line. */
function flatten(message: string | DiagnosticMessageChain): string {
  if (typeof message === 'string') return message
  let text = message.getMessageText()
  for (const next of message.getNext() ?? []) text += ' ' + flatten(next)
  return text
}

/**
 * The flagship check: an API the generated code invented. The TS checker answers
 * exactly, so a hit here is proven — but only report hits on changed lines,
 * otherwise this is just `tsc` output rather than a review.
 */
export const phantomApi: Verifier = {
  name: 'phantom-api',
  needs: ['types'],
  run(g: Ground): Finding[] {
    // Without a tsconfig the checker has no lib or path resolution, and every
    // global would look invented. Refusing to run beats reporting garbage.
    if (!g.typed) return []

    const findings: Finding[] = []
    for (const { sf, changed, typed } of g.files) {
      // a file the tsconfig does not include has no bound program; the checker
      // throws rather than answering, and the answer would be garbage anyway
      if (!typed) continue
      const file = relPath(sf, g.root)

      for (const d of sf.getPreEmitDiagnostics()) {
        const code = d.getCode()
        const label = HALLUCINATION_CODES.get(code)
        if (!label) continue
        const start = d.getStart()
        const line = d.getLineNumber()
        if (line === undefined || !changed.added.has(line)) continue
        const span = start === undefined ? undefined : locate(sf, start, d.getLength() ?? 1).span

        const detail = flatten(d.getMessageText())

        findings.push({
          id: '',
          class: 'verified',
          check: 'phantom-api',
          severity: 'high',
          confidence: 'proven',
          file,
          line,
          span,
          title: detail,
          replacement: suggestedName(detail),
          evidence: { oracle: 'typescript', detail: 'TS' + code + ': ' + label },
        })
      }
    }
    return findings
  },
}
