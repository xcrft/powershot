import type { Finding, Ground, Verifier } from '#app/types.js'
import { walk, type LanguagePack, type Node } from '#app/lang/packs.js'
import { declaredName, finding, topLevelDeclarations } from './foreign-tokens.js'

/** Names too common to mean anything across files, as in the TypeScript version. */
const GENERIC = new Set([
  'render', 'handler', 'handle', 'create', 'update', 'remove', 'delete', 'insert',
  'process', 'execute', 'convert', 'default', 'discover', 'initialize', 'configure',
  'validate', 'serialize', 'deserialize', 'to_string', 'from_str', 'builder', 'build',
])

/**
 * Test modules are excluded on purpose.
 *
 * A fixture builder repeated in two test files is a deliberate trade — a test that
 * reads on its own beats one coupled to a shared helper — and two test functions
 * describing the same scenario naturally carry the same name. Measured on a real
 * repository this was the single largest source of noise.
 */
const TESTISH = /(^|\/)(tests?|spec|__tests__)\/|(^|\/)(test_[^/]+|[^/]+_test|[^/]+\.(test|spec))\.[a-z]+$/

export const foreignReinvented: Verifier = {
  name: 'reinvented',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    if (g.foreign.length < 2) return findings

    // Keyed by language as well as name: a Ruby `charge` and a C++ `charge` are two
    // unrelated functions that happen to share a word, and calling that duplication
    // would be nonsense — nothing can be reused across the boundary anyway.
    const index = new Map<string, { file: string; line: number }[]>()
    for (const file of g.foreign) {
      if (TESTISH.test(file.path)) continue
      for (const [name, decl] of topLevelDeclarations(file.tree.rootNode, file.pack)) {
        const key = file.pack.name + '|' + name.toLowerCase().replace(/[^a-z0-9]/g, '')
        const list = index.get(key) ?? []
        list.push({ file: file.path, line: decl.startPosition.row + 1 })
        index.set(key, list)
      }
    }

    for (const file of g.foreign) {
      if (TESTISH.test(file.path)) continue
      for (const [name, decl] of topLevelDeclarations(file.tree.rootNode, file.pack)) {
        const line = decl.startPosition.row + 1
        if (!file.changed.added.has(line)) continue
        if (name.length < 6 || GENERIC.has(name.toLowerCase())) continue
        const key = file.pack.name + '|' + name.toLowerCase().replace(/[^a-z0-9]/g, '')
        const match = (index.get(key) ?? []).find((e) => e.file !== file.path)
        // report the pair once, from the file that declares it later
        if (!match || match.file < file.path) continue

        findings.push(
          finding(file, decl, {
            check: 'reinvented',
            severity: 'medium',
            confidence: 'firm',
            title: name + '() duplicates a declaration in ' + match.file,
            evidence: { oracle: file.pack.name + ' declarations', detail: 'already declared at ' + match.file + ':' + match.line },
            fix: 'Reuse the existing one instead of redeclaring it',
          }),
        )
      }
    }
    return findings
  },
}
