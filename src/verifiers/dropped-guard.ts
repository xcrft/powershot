import { Node, SyntaxKind, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

type Fn = { name: string; node: Node }

function functionsOf(sf: SourceFile): Fn[] {
  const out: Fn[] = []
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (name) out.push({ name, node: fn })
  }
  for (const cls of sf.getClasses()) {
    const prefix = (cls.getName() ?? 'anonymous') + '.'
    for (const m of cls.getMethods()) out.push({ name: prefix + m.getName(), node: m })
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (init?.isKind(SyntaxKind.ArrowFunction) || init?.isKind(SyntaxKind.FunctionExpression)) {
      out.push({ name: v.getName(), node: v })
    }
  }
  return out
}

/** collapse whitespace so reformatting alone never reads as a dropped guard */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** every identifier the new version of a function still mentions */
function identifiersIn(fn: Node): Set<string> {
  const out = new Set<string>()
  for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier)) out.add(id.getText())
  return out
}

/**
 * The things a condition actually reads: the base of each reference, never the
 * property names hanging off it. In `!inv.customer` the root is `inv` — `customer`
 * is a field, and a rewritten body has no reason to mention it.
 */
function rootsOf(condition: Node): string[] {
  const roots: string[] = []
  for (const id of condition.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const parent = id.getParent()
    // skip the `.name` half of a property access, and object-literal keys
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue
    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) continue
    roots.push(id.getText())
  }
  if (Node.isIdentifier(condition)) roots.push(condition.getText())
  return roots
}

/**
 * A guard whose roots the rewritten function no longer has is not a guard someone
 * dropped — it stopped existing along with the code it protected. `formatWeight`
 * rewritten from ounces to grams cannot keep `if (pounds === 0)`, and reporting it
 * would accuse a deliberate rewrite of losing a check it could not have kept.
 */
function stillApplicable(roots: string[], available: Set<string>): boolean {
  return roots.every((n) => available.has(n) || GLOBALS.has(n))
}

/**
 * The same check, respelled. When `pool` turns from an array into a number,
 * `pool.length === 0` becomes `pool === 0`: different text, same guarantee. Matching
 * on what a guard reads rather than how it is written keeps a rewrite from reading
 * as a removal — at the cost of missing a guard narrowed on the same variable, which
 * is the direction this tool chooses to err in.
 */
function guardedElsewhere(roots: string[], after: Map<string, string[]>): boolean {
  if (roots.length === 0) return false
  return [...after.values()].some((other) => roots.every((r) => other.includes(r)))
}

const GLOBALS = new Set(['undefined', 'NaN', 'Number', 'String', 'Array', 'Object', 'Boolean', 'Math', 'JSON', 'Date'])

/**
 * A guard is an `if` whose branch bails out — throw, return, continue, or break.
 * That shape is what protects the code below it, so losing one changes behaviour.
 */
function guardsOf(fn: Node): Map<string, string[]> {
  const guards = new Map<string, string[]>()
  for (const ifStmt of fn.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const branch = ifStmt.getThenStatement()
    const bails =
      branch.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0 ||
      branch.getDescendantsOfKind(SyntaxKind.ReturnStatement).length > 0 ||
      branch.getDescendantsOfKind(SyntaxKind.ContinueStatement).length > 0 ||
      branch.getDescendantsOfKind(SyntaxKind.BreakStatement).length > 0 ||
      Node.isThrowStatement(branch) ||
      Node.isReturnStatement(branch)
    if (bails) guards.set(normalize(ifStmt.getExpression().getText()), rootsOf(ifStmt.getExpression()))
  }
  return guards
}

/**
 * A guard that existed before the change and is gone after it, in a function that
 * still exists. The pre/post AST pair is the oracle, so this is proven: the
 * condition text was there and now it is not.
 */
export const droppedGuard: Verifier = {
  name: 'dropped-guard',
  needs: ['syntax', 'base'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const { sf, before } of g.files) {
      if (!before) continue // a new file cannot have dropped anything

      const after = new Map(functionsOf(sf).map((f) => [f.name, f]))
      for (const prev of functionsOf(before)) {
        const now = after.get(prev.name)
        if (!now) continue // function removed entirely — that is a different finding

        const had = guardsOf(prev.node)
        if (had.size === 0) continue
        const has = guardsOf(now.node)
        const available = identifiersIn(now.node)

        const dropped = [...had.entries()]
          .filter(
            ([guard, roots]) =>
              !has.has(guard) && stillApplicable(roots, available) && !guardedElsewhere(roots, has),
          )
          .map(([guard]) => guard)
        if (dropped.length === 0) continue

        // one finding per function, not per guard: several guards lost in the same
        // rewrite are one fact about one place, and repeating the line is noise
        findings.push({
          id: '',
          class: 'verified',
          check: 'dropped-guard',
          severity: 'high',
          confidence: 'proven',
          file: relPath(sf, g.root),
          line: now.node.getStartLineNumber(),
          span: locate(sf, now.node.getStart(), Math.min(now.node.getWidth(), 80)).span,
          title:
            dropped.map((d) => '`if (' + d + ')`').join(' and ') +
            ' ' + (dropped.length > 1 ? 'were' : 'was') +
            ' present in ' + prev.name + '() before this change and ' + (dropped.length > 1 ? 'are' : 'is') + ' gone',
          evidence: { oracle: 'pre/post AST', detail: 'early-exit branch removed while the function still exists and still uses the same names' },
        })
      }
    }
    return findings
  },
}
