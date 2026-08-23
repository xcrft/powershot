import type { Finding, Ground, Verifier } from '#app/types.js'
import { nodesOfType, walk, type LanguagePack, type Node } from '#app/lang/packs.js'
import { declaredName, finding, topLevelDeclarations } from './foreign-tokens.js'

function guardsOf(fn: Node, pack: LanguagePack): Map<string, string[]> {
  const guards = new Map<string, string[]>()
  for (const stmt of nodesOfType(fn, pack.nodes.ifStatement)) {
    const cond = stmt.childForFieldName(pack.nodes.ifCondition)
    const body = stmt.childForFieldName(pack.nodes.ifBody)
    if (!cond || !body) continue
    const bails = nodesOfType(body, pack.nodes.bail).length > 0
    if (!bails) continue
    const roots = nodesOfType(cond, pack.nodes.identifier).map((n) => n.text)
    guards.set(cond.text.replace(/\s+/g, ' ').trim(), roots)
  }
  return guards
}


/** Declarations at module level — the names another file could actually import. */
export 
function functionsByName(root: Node, pack: LanguagePack): Map<string, Node> {
  const all = nodesOfType(root, pack.nodes.declaration)
  const out = new Map<string, Node>()
  for (const decl of all) {
    const containsAnother = all.some(
      (other) =>
        other !== decl &&
        other.startPosition.row >= decl.startPosition.row &&
        other.endPosition.row <= decl.endPosition.row,
    )
    if (containsAnother) continue
    const name = declaredName(decl, pack)
    if (name) out.set(name, decl)
  }
  return out
}

/** A guard the change removed from a function that still exists — see the TS version
 *  for why obsolete and respelled guards are excluded. */
export const foreignDroppedGuard: Verifier = {
  name: 'dropped-guard',
  needs: ['syntax', 'base'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const file of g.foreign) {
      if (!file.beforeTree) continue
      const after = functionsByName(file.tree.rootNode, file.pack)

      for (const [name, prev] of functionsByName(file.beforeTree.rootNode, file.pack)) {
        const now = after.get(name)
        if (!now) continue

        const had = guardsOf(prev, file.pack)
        if (had.size === 0) continue
        const has = guardsOf(now, file.pack)
        const available = new Set(nodesOfType(now, file.pack.nodes.identifier).map((n) => n.text))

        const dropped = [...had.entries()]
          .filter(([text, roots]) => {
            if (has.has(text)) return false
            if (!roots.every((r) => available.has(r))) return false // obsolete with the code it protected
            return ![...has.values()].some((other) => roots.every((r) => other.includes(r))) // respelled
          })
          .map(([text]) => text)
        if (dropped.length === 0) continue

        findings.push(
          finding(file, now, {
            check: 'dropped-guard',
            severity: 'high',
            confidence: 'proven',
            title:
              dropped.map((d) => '`' + d + '`').join(' and ') + ' guarded ' + name + '() before this change and ' +
              (dropped.length > 1 ? 'are' : 'is') + ' gone',
            evidence: { oracle: file.pack.name + ' pre/post AST', detail: 'early-exit branch removed while the function still uses the same names' },
          }),
        )
      }
    }
    return findings
  },
}
