import { Node, SyntaxKind, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

type Decl = { name: string; node: Node & { findReferencesAsNodes(): Node[] }; nameStart: number; nameWidth: number; line: number }

/**
 * Only module-private declarations are considered. An exported symbol with no callers
 * may simply be public API this repo does not consume itself, which is not a defect —
 * an unexported one that nothing in its own module reaches provably is.
 */
function privateDeclarations(sf: SourceFile): Decl[] {
  const out: Decl[] = []

  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    const id = fn.getNameNode()
    if (!name || !id || fn.isExported() || fn.isDefaultExport()) continue
    out.push({ name, node: fn, nameStart: id.getStart(), nameWidth: id.getWidth(), line: fn.getStartLineNumber() })
  }

  for (const cls of sf.getClasses()) {
    const name = cls.getName()
    const id = cls.getNameNode()
    if (!name || !id || cls.isExported() || cls.isDefaultExport()) continue
    out.push({ name, node: cls, nameStart: id.getStart(), nameWidth: id.getWidth(), line: cls.getStartLineNumber() })
  }

  for (const stmt of sf.getVariableStatements()) {
    if (stmt.isExported()) continue
    for (const v of stmt.getDeclarations()) {
      const id = v.getNameNode()
      // destructuring binds several names at once; skip rather than guess which is dead
      if (!Node.isIdentifier(id)) continue
      out.push({
        name: v.getName(),
        node: v,
        nameStart: id.getStart(),
        nameWidth: id.getWidth(),
        line: v.getStartLineNumber(),
      })
    }
  }

  return out
}

/** `_unused` is the conventional way to say "deliberately not referenced". */
function deliberatelyUnused(name: string): boolean {
  return name.startsWith('_')
}

/** Code the change adds that nothing reaches. */
export const deadOnArrival: Verifier = {
  name: 'dead-on-arrival',
  needs: ['references'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    for (const { sf, changed } of g.files) {
      const file = relPath(sf, g.root)

      for (const decl of privateDeclarations(sf)) {
        if (!changed.added.has(decl.line)) continue
        if (deliberatelyUnused(decl.name)) continue

        let refs: Node[]
        try {
          refs = decl.node.findReferencesAsNodes()
        } catch {
          continue // no answer from the language service is not the same as "no callers"
        }
        if (refs.length > 0) continue

        // A decorator can register what it decorates without ever naming it again,
        // so for those the reference graph answers a narrower question than the one
        // the finding asks. Everywhere else nothing outside the module can reach a
        // module-private name at all, which is what makes the graph's answer exact.
        const decorated = Node.isDecoratable(decl.node) && decl.node.getDecorators().length > 0

        findings.push({
          id: '',
          class: 'verified',
          check: 'dead-on-arrival',
          severity: 'low',
          confidence: decorated ? 'firm' : 'proven',
          file,
          line: decl.line,
          span: locate(sf, decl.nameStart, decl.nameWidth).span,
          title: decl.name + ' is added by this change and nothing references it',
          evidence: { oracle: 'reference graph', detail: 'module-private and unreferenced anywhere in the project' },
          fix: 'Delete it, or export it if something outside this module is meant to use it',
        })
      }
    }
    return findings
  },
}
