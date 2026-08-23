import { Node, SyntaxKind, type Statement } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

/** console.error / logger.warn / log.info — a call that records and returns */
const LOGGER = /^(console|logger|log)\s*\./

/** A catch body that only logs has recorded the failure and carried on regardless. */
function isLogOnly(statements: Statement[]): boolean {
  if (statements.length === 0) return false
  return statements.every((s) => {
    if (!Node.isExpressionStatement(s)) return false
    let expr = s.getExpression()
    if (Node.isAwaitExpression(expr)) expr = expr.getExpression()
    if (!Node.isCallExpression(expr)) return false
    return LOGGER.test(expr.getExpression().getText())
  })
}

/**
 * A comment inside an otherwise empty block is the author saying "I meant this".
 * Deliberate silence is not a defect, so respect the signal.
 */
function hasComment(text: string): boolean {
  return /\/\/|\/\*/.test(text)
}

/** Error handling that looks defensive and defends nothing. */
export const swallowedError: Verifier = {
  name: 'swallowed-error',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    for (const { sf, changed } of g.files) {
      const file = relPath(sf, g.root)

      for (const clause of sf.getDescendantsOfKind(SyntaxKind.CatchClause)) {
        const line = clause.getStartLineNumber()
        if (!changed.added.has(line)) continue

        const block = clause.getBlock()
        const statements = block.getStatements()
        const span = locate(sf, block.getStart(), block.getWidth()).span

        if (statements.length === 0) {
          if (hasComment(block.getFullText())) continue
          findings.push({
            id: '',
            class: 'verified',
            check: 'swallowed-error',
            severity: 'high',
            confidence: 'proven',
            file,
            line,
            span,
            title: 'Empty catch block — the failure is discarded and the caller is told it succeeded',
            evidence: { oracle: 'AST', detail: 'catch body contains no statements' },
            fix: 'Rethrow, return a typed failure, or add a comment saying why it is safe to ignore',
          })
          continue
        }

        if (isLogOnly(statements)) {
          findings.push({
            id: '',
            class: 'verified',
            check: 'swallowed-error',
            severity: 'medium',
            confidence: 'firm',
            file,
            line,
            span,
            title: 'Catch only logs — execution continues as if the operation had succeeded',
            evidence: { oracle: 'AST', detail: 'catch body contains logging calls and nothing else: no rethrow, no return, no recovery' },
            fix: 'Rethrow after logging, or return a value that tells the caller it failed',
          })
        }
      }

      // .catch(() => {}) — the promise-chain spelling of the same defect
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression()
        if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'catch') continue
        const line = call.getStartLineNumber()
        if (!changed.added.has(line)) continue

        const handler = call.getArguments()[0]
        if (!handler || !(Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) continue
        const body = handler.getBody()
        if (!Node.isBlock(body) || body.getStatements().length > 0) continue
        if (hasComment(body.getFullText())) continue

        findings.push({
          id: '',
          class: 'verified',
          check: 'swallowed-error',
          severity: 'high',
          confidence: 'proven',
          file,
          line,
          span: locate(sf, handler.getStart(), handler.getWidth()).span,
          title: 'Empty .catch() — the rejection is discarded and the chain resolves as success',
          evidence: { oracle: 'AST', detail: 'catch handler body contains no statements' },
          fix: 'Handle the rejection, or drop the .catch() so it propagates',
        })
      }
    }
    return findings
  },
}
