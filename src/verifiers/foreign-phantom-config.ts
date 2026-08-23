import type { Finding, Ground, Verifier } from '#app/types.js'
import { nodesOfType, walk, type LanguagePack, type Node } from '#app/lang/packs.js'
import { finding } from './foreign-tokens.js'

export const foreignPhantomConfig: Verifier = {
  name: 'phantom-config',
  needs: ['syntax'],
  supports: (file) => file.pack.envReads !== undefined,
  run(g: Ground): Finding[] {
    if (g.foreign.length === 0) return []

    // a key read anywhere else in the change is a documentation gap, not an invention
    const elsewhere = new Set<string>()
    for (const file of g.foreign) {
      for (const read of file.pack.envReads?.(file.tree.rootNode) ?? []) {
        if (!file.changed.added.has(read.node.startPosition.row + 1)) elsewhere.add(read.name)
      }
    }

    const findings: Finding[] = []
    for (const file of g.foreign) {
      for (const read of file.pack.envReads?.(file.tree.rootNode) ?? []) {
        const line = read.node.startPosition.row + 1
        if (!file.changed.added.has(line)) continue
        if (g.envManifest?.keys.has(read.name) || elsewhere.has(read.name)) continue
        if (!g.envManifest) continue // no manifest to be wrong about

        findings.push(
          finding(file, read.node, {
            check: 'phantom-config',
            severity: 'medium',
            confidence: 'proven',
            title: 'Reads ' + read.name + ', which is not declared in ' + g.envManifest.file,
            evidence: { oracle: g.envManifest.file, detail: 'the key appears in no manifest entry and nowhere else in the change' },
            fix: 'Add ' + read.name + ' to ' + g.envManifest.file + ', or drop the reference',
          }),
        )
      }
    }
    return findings
  },
}
