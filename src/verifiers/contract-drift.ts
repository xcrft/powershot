import { Node, SyntaxKind, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

type Param = { name: string; type: string; optional: boolean }
type Sig = { name: string; params: Param[]; required: number; returns: string }

/**
 * Parameters read syntactically so the same extraction works on the base-ref project,
 * which is parsed without type information.
 */
function signatureOf(name: string, node: Node): Sig | undefined {
  const fn = Node.isFunctionDeclaration(node)
    ? node
    : Node.isVariableDeclaration(node)
      ? node.getInitializerIfKind(SyntaxKind.ArrowFunction) ?? node.getInitializerIfKind(SyntaxKind.FunctionExpression)
      : undefined
  if (!fn) return undefined

  const params: Param[] = fn.getParameters().map((p) => ({
    name: p.getName(),
    type: p.getTypeNode()?.getText() ?? '',
    // a parameter with `?`, a default, or a rest spread is not required of the caller
    optional: p.hasQuestionToken() || p.hasInitializer() || p.isRestParameter(),
  }))

  return {
    name,
    params,
    required: params.filter((p) => !p.optional).length,
    returns: fn.getReturnTypeNode()?.getText() ?? '',
  }
}

/** Top-level functions and exported arrow/function consts, by name. */
function signatures(sf: SourceFile): Map<string, Sig> {
  const out = new Map<string, Sig>()
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    const sig = signatureOf(name, fn)
    if (sig) out.set(name, sig)
  }
  for (const v of sf.getVariableDeclarations()) {
    const sig = signatureOf(v.getName(), v)
    if (sig) out.set(v.getName(), sig)
  }
  return out
}

type Break = { detail: string; proven: boolean }

/**
 * Only changes that actually cost a caller something are reported. Adding an optional
 * parameter or widening a name is invisible from the outside, so it stays silent.
 */
function breakingChange(before: Sig, after: Sig): Break | undefined {
  if (after.required > before.required) {
    return {
      detail:
        'now requires ' + after.required + ' argument(s), was ' + before.required,
      proven: true, // every existing call site is now short an argument
    }
  }
  if (after.params.length < before.params.length) {
    return {
      detail: 'takes ' + after.params.length + ' parameter(s), was ' + before.params.length,
      proven: true,
    }
  }
  for (let i = 0; i < Math.min(before.params.length, after.params.length); i++) {
    const b = before.params[i]!
    const a = after.params[i]!
    if (b.type !== '' && a.type !== '' && b.type !== a.type) {
      return { detail: 'parameter `' + a.name + '` changed from ' + b.type + ' to ' + a.type, proven: false }
    }
  }
  if (before.returns !== '' && after.returns !== '' && before.returns !== after.returns) {
    return { detail: 'returns ' + after.returns + ', was ' + before.returns, proven: false }
  }
  return undefined
}

/**
 * A signature changed and callers outside the change were left behind.
 *
 * This is the blast radius `phantom-api` cannot see: that check only reports on lines
 * the diff touched, so a call site broken in a file nobody edited is invisible to it.
 * Here the reference graph is the oracle — the callers either exist or they do not.
 */
export const contractDrift: Verifier = {
  name: 'contract-drift',
  needs: ['syntax', 'base', 'references'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    const changedPaths = new Set(g.changed.map((c) => c.path))

    for (const { sf, before } of g.files) {
      if (!before) continue
      const file = relPath(sf, g.root)
      const now = signatures(sf)

      for (const [name, was] of signatures(before)) {
        const is = now.get(name)
        if (!is) continue // removed entirely — a different finding

        const broke = breakingChange(was, is)
        if (!broke) continue

        // the declaration node, both to position the finding and to walk references
        const decl =
          sf.getFunction(name) ?? sf.getVariableDeclaration(name)
        if (!decl) continue

        let callers: string[] = []
        try {
          callers = [
            ...new Set(
              decl
                .findReferencesAsNodes()
                .map((ref) => relPath(ref.getSourceFile(), g.root))
                .filter((path) => path !== file && !changedPaths.has(path) && !path.includes('node_modules')),
            ),
          ]
        } catch {
          // the language service can decline on a malformed project; no references
          // found is not the same as none existing, so stay silent rather than guess
          continue
        }
        if (callers.length === 0) continue

        const shown = callers.slice(0, 3).join(', ') + (callers.length > 3 ? ' +' + (callers.length - 3) + ' more' : '')
        const nameNode = Node.isFunctionDeclaration(decl) ? decl.getNameNode() : decl.getNameNode()

        findings.push({
          id: '',
          class: 'verified',
          check: 'contract-drift',
          severity: broke.proven ? 'high' : 'medium',
          confidence: broke.proven ? 'proven' : 'firm',
          file,
          line: decl.getStartLineNumber(),
          span: nameNode ? locate(sf, nameNode.getStart(), nameNode.getWidth()).span : undefined,
          title:
            name + '() ' + broke.detail + ', but ' + callers.length + ' call site(s) outside this change were not updated',
          evidence: { oracle: 'reference graph', detail: 'callers in ' + shown },
          fix: 'Update the call sites, or keep the old shape working (optional parameter, overload)',
        })
      }
    }
    return findings
  },
}
