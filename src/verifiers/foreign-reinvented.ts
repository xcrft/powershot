import type { Finding, Ground, Verifier } from '#app/types.js'
import type { LanguagePack, Node } from '#app/lang/packs.js'
import { createReinventionScopeResolver, implementationFingerprint } from '#app/reinvention.js'
import { finding, tokensFor, topLevelDeclarations } from './foreign-tokens.js'

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

function normalized(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

type Declaration = { name: string; node: Node; fingerprint: string }
type DeclarationIndex = Map<string, Declaration[]>

function declarationIndex(root: Node, pack: LanguagePack): DeclarationIndex {
  const index: DeclarationIndex = new Map()
  for (const [name, node] of topLevelDeclarations(root, pack)) {
    const key = normalized(name)
    const list = index.get(key) ?? []
    list.push({ name, node, fingerprint: implementationFingerprint(tokensFor(node, pack)) })
    index.set(key, list)
  }
  return index
}

export const foreignReinvented: Verifier = {
  name: 'reinvented',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    if (g.foreign.length < 2) return findings

    // Keyed by language as well as name: a Ruby `charge` and a C++ `charge` are two
    // unrelated functions that happen to share a word, and calling that duplication
    // would be nonsense — nothing can be reused across the boundary anyway.
    const scopeFor = createReinventionScopeResolver(g.root)
    const index = new Map<string, { file: string; line: number; fingerprint: string; scope: string }[]>()
    const declarations = new Map<string, { current: DeclarationIndex; base?: DeclarationIndex }>()
    for (const file of g.foreign) {
      declarations.set(file.path, {
        current: declarationIndex(file.tree.rootNode, file.pack),
        base: file.beforeTree ? declarationIndex(file.beforeTree.rootNode, file.pack) : undefined,
      })
    }
    for (const file of g.foreign) {
      if (TESTISH.test(file.path) || !file.beforeTree) continue
      const fileDeclarations = declarations.get(file.path)!
      for (const [nameKey, baseDeclarations] of fileDeclarations.base ?? []) {
        for (const baseDeclaration of baseDeclarations) {
          const currentDeclaration = (fileDeclarations.current.get(nameKey) ?? []).find(
            (declaration) => declaration.fingerprint === baseDeclaration.fingerprint,
          )
          // The reusable declaration must both predate the change and remain available
          // at the reviewed head. A removed or rewritten helper is not a candidate.
          if (!currentDeclaration) continue
          const key = file.pack.name + '|' + nameKey
          const list = index.get(key) ?? []
          list.push({
            file: file.path,
            line: currentDeclaration.node.startPosition.row + 1,
            fingerprint: baseDeclaration.fingerprint,
            scope: scopeFor(file.path),
          })
          index.set(key, list)
        }
      }
    }

    for (const file of g.foreign) {
      if (TESTISH.test(file.path)) continue
      const fileDeclarations = declarations.get(file.path)!
      for (const [nameKey, currentDeclarations] of fileDeclarations.current) {
        for (const { name, node: decl, fingerprint } of currentDeclarations) {
          const line = decl.startPosition.row + 1
          if (!file.changed.added.has(line)) continue
          if (name.length < 6 || GENERIC.has(name.toLowerCase())) continue
          const existedHere = (fileDeclarations.base?.get(nameKey) ?? []).some(
            (baseDeclaration) => baseDeclaration.fingerprint === fingerprint,
          )
          if (existedHere) continue
          const key = file.pack.name + '|' + nameKey
          const scope = scopeFor(file.path)
          const match = (index.get(key) ?? []).find(
            (candidate) =>
              candidate.file !== file.path &&
              candidate.scope === scope &&
              candidate.fingerprint === fingerprint,
          )
          if (!match) continue

          findings.push(
            finding(file, decl, {
              check: 'reinvented',
              severity: 'medium',
              confidence: 'firm',
              title: name + ' repeats the implementation at ' + match.file,
              evidence: {
                oracle: file.pack.name + ' base declaration + token fingerprint',
                detail: 'token-identical implementation already present at ' + match.file + ':' + match.line,
              },
              fix: 'Consider reusing the existing declaration; if the separation is intentional, keep the boundary explicit',
            }),
          )
        }
      }
    }
    return findings
  },
}
