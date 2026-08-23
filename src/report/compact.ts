import type { Finding } from '#app/types.js'

/**
 * `src/a.ts:42:9: error: message [check]` — the shape compilers have emitted for
 * decades, and the whole IDE integration. Problem matchers, errorformat and every
 * "jump to next error" already parse it, so there is no extension to maintain.
 */
export function compact(findings: Finding[]): string {
  return (
    findings
      .map((f) => {
        const severity = f.severity === 'critical' || f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : 'info'
        const column = f.span?.column ?? 1
        return f.file + ':' + f.line + ':' + column + ': ' + severity + ': ' + f.title + ' [' + f.check + ']'
      })
      .join('\n') + (findings.length > 0 ? '\n' : '')
  )
}
