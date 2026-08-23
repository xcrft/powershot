import type { Finding, Ground, Verifier } from '#app/types.js'

/**
 * Error handling that defends nothing, in languages the TypeScript compiler cannot
 * read. The rule is per-language because the idiom is: Python discards a failure with
 * `except: pass`, Go with an `if err != nil` whose body does nothing. Each pack knows
 * its own spelling; this verifier only asks.
 */
export const foreignSwallowedError: Verifier = {
  name: 'swallowed-error',
  needs: ['syntax'],
  supports: (file) => file.pack.swallowedError !== undefined,
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    for (const file of g.foreign) {
      for (const hit of file.pack.swallowedError?.(file.tree.rootNode) ?? []) {
        const line = hit.node.startPosition.row + 1
        if (!file.changed.added.has(line)) continue

        findings.push({
          id: '',
          class: 'verified',
          check: 'swallowed-error',
          severity: hit.what.includes('only logs') ? 'medium' : 'high',
          confidence: hit.what.includes('only logs') ? 'firm' : 'proven',
          file: file.path,
          line,
          span: { column: hit.node.startPosition.column + 1, length: Math.min(hit.node.text.split('\n')[0]?.length ?? 1, 80) },
          title: hit.what.charAt(0).toUpperCase() + hit.what.slice(1) + ' — the failure is discarded',
          evidence: { oracle: file.pack.name + ' AST', detail: 'parsed by tree-sitter; no type information required' },
          fix: 'Handle it, return it, or say in a comment why ignoring it is safe',
        })
      }
    }
    return findings
  },
}
