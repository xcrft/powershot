import type { Finding, Ground, Verifier } from '#app/types.js'
import { nodesOfType, walk, type LanguagePack, type Node } from '#app/lang/packs.js'
import { finding, tokensFor, type Tok } from './foreign-tokens.js'

const MIN_TOKENS = 8

/** import / use / require statements, whatever each grammar calls them */
const IMPORTISH = /import|use_declaration|require|include|using_directive|package_/

/** The defect is an inconsistent rename, not the duplication — see the TS version. */
function missedRename(a: Tok[], b: Tok[], pack: LanguagePack): { name: string; became: string[] } | undefined {
  if (a.length !== b.length || a.length < MIN_TOKENS) return undefined
  const mapping = new Map<string, Set<string>>()
  let renamed = false

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.type !== y.type) return undefined
    if (!pack.nodes.identifier.includes(x.type)) {
      if (x.text !== y.text) return undefined
      continue
    }
    if (x.text !== y.text) renamed = true
    const targets = mapping.get(x.text) ?? new Set<string>()
    targets.add(y.text)
    mapping.set(x.text, targets)
  }
  if (!renamed) return undefined

  for (const [name, targets] of mapping) {
    // The signature of a missed rename is that one occurrence changed and another
    // stayed behind, so the original name must be among the targets. Two different
    // things that merely share a name map to two *new* names, which is not a rename
    // anyone forgot. Found by running this check over its own repository.
    if (targets.size > 1 && targets.has(name)) return { name, became: [...targets] }
  }
  return undefined
}

function statementLists(root: Node, pack: LanguagePack): Node[][] {
  const lists: Node[][] = [root.namedChildren]
  for (const block of nodesOfType(root, pack.nodes.block)) lists.push(block.namedChildren)
  return lists
}

export const foreignCopyPasteDrift: Verifier = {
  name: 'copy-paste-drift',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const file of g.foreign) {
      for (const statements of statementLists(file.tree.rootNode, file.pack)) {
        for (let i = 1; i < statements.length; i++) {
          const prev = statements[i - 1]!
          const curr = statements[i]!
          const line = curr.startPosition.row + 1
          if (!file.changed.added.has(line)) continue
          if (file.pack.nodes.comment.includes(curr.type) || file.pack.nodes.comment.includes(prev.type)) continue
          // Consecutive imports from the same package share a shape by nature — a
          // list of what a file uses is not a block anyone copied and half-renamed.
          if (IMPORTISH.test(curr.type) || IMPORTISH.test(prev.type)) continue

          const miss = missedRename(tokensFor(prev, file.pack), tokensFor(curr, file.pack), file.pack)
          if (!miss) continue

          findings.push(
            finding(file, curr, {
              check: 'copy-paste-drift',
              severity: 'high',
              confidence: 'firm',
              title:
                'Copied from the statement above with `' + miss.name + '` renamed inconsistently — it became ' +
                miss.became.map((t) => '`' + t + '`').join(' in one place and ') + ' in another',
              evidence: { oracle: file.pack.name + ' token stream', detail: 'identical shape and literals, one identifier left un-renamed' },
              fix: 'Rename the remaining `' + miss.name + '`, or extract the shared shape',
            }),
          )
        }
      }
    }
    return findings
  },
}
