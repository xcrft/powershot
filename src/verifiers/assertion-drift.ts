import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(__tests__\/)/
const TEST_FN = /^(it|test)(\.(only|each|concurrent|skip))?$/
const NODE_ASSERT = /^(assert|t)\.(equal|strictEqual|deepEqual|deepStrictEqual|is|deepIs)$/

type Assertion = {
  expected: string
  line: number
  subject: string
  span?: { column: number; length: number }
  /** the enclosing test with the expected value masked, to tell a bend from a rewrite */
  context: string
}

/**
 * Walk left through a matcher chain (`expect(x).not.toBe`) back to the
 * `expect(...)` call, so the subject is found regardless of modifiers.
 */
function expectSubjectOf(callee: Node): string | undefined {
  let node: Node | undefined = callee
  while (node && Node.isPropertyAccessExpression(node)) node = node.getExpression()
  if (!node || !Node.isCallExpression(node)) return undefined
  if (node.getExpression().getText() !== 'expect') return undefined
  return node.getArguments()[0]?.getText() ?? ''
}

/** The enclosing it()/test() call, which is how an assertion is matched across versions. */
function enclosingTest(node: Node): CallExpression | undefined {
  let current: Node | undefined = node
  while (current) {
    if (Node.isCallExpression(current) && TEST_FN.test(current.getExpression().getText())) return current
    current = current.getParent()
  }
  return undefined
}

/** The test with its expected value blanked out and whitespace collapsed. */
function contextOf(test: Node, expectedNode: Node): string {
  // masked by position, never by text: `expect(withVat(1000)).toBe(1000)` would
  // otherwise blank both occurrences and make every such test look rewritten
  const text = test.getText()
  const start = expectedNode.getStart() - test.getStart()
  const end = start + expectedNode.getWidth()
  if (start < 0 || end > text.length) return text.replace(/\s+/g, ' ').trim()
  return (text.slice(0, start) + '\u0000' + text.slice(end)).replace(/\s+/g, ' ').trim()
}

/**
 * Key an assertion by what it is asserting *about*, never by its expected value —
 * the whole point is to detect the expected value moving underneath a stable subject.
 */
function assertionsIn(sf: SourceFile): Map<string, Assertion> {
  const out = new Map<string, Assertion>()

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeText = call.getExpression().getText()
    let subject: string | undefined
    let matcher: string
    let expectedNode: Node | undefined

    if (Node.isPropertyAccessExpression(call.getExpression())) {
      subject = expectSubjectOf(call.getExpression())
      matcher = (call.getExpression() as ReturnType<CallExpression['getExpression']> & { getName(): string }).getName()
      expectedNode = call.getArguments()[0]
    } else {
      matcher = ''
      expectedNode = undefined
    }

    if (subject === undefined && NODE_ASSERT.test(calleeText)) {
      subject = call.getArguments()[0]?.getText()
      matcher = calleeText
      expectedNode = call.getArguments()[1]
    }

    if (subject === undefined || expectedNode === undefined) continue
    const expected = expectedNode.getText()
    const test = enclosingTest(call)
    const title = test?.getArguments()[0]?.getText()
    if (test === undefined || title === undefined) continue

    out.set(title + '|' + subject + '|' + matcher, {
      expected,
      line: call.getStartLineNumber(),
      subject,
      span: locate(sf, call.getStart(), call.getWidth()).span,
      context: contextOf(test, expectedNode),
    })
  }
  return out
}

/** An expected value edited to match new output, rather than the code being fixed. */
export const assertionDrift: Verifier = {
  name: 'assertion-drift',
  needs: ['syntax', 'base'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    // The modules this change actually edited, by basename. Whether *some* source
    // moved is the wrong question — a large change can edit one module and bend an
    // unrelated test. What matters is whether the module a given test covers moved.
    const changedModules = new Set(
      g.files
        .map(({ sf }) => relPath(sf, g.root))
        .filter((p) => !TEST_FILE.test(p))
        .map((p) => (p.split('/').pop() ?? '').replace(/\.[cm]?[jt]sx?$/, '')),
    )

    for (const { sf, before } of g.files) {
      if (!before) continue
      const file = relPath(sf, g.root)
      if (!TEST_FILE.test(file)) continue

      // An expectation moving alongside a change to the module it covers is what an
      // intentional behaviour change looks like. Only the giveaway survives: the
      // expectation moved and the thing it measures did not.
      const subject = (file.split('/').pop() ?? '').replace(/\.(test|spec)\.[cm]?[jt]sx?$/, '')
      if (changedModules.has(subject)) continue

      const now = assertionsIn(sf)
      for (const [key, was] of assertionsIn(before)) {
        const is = now.get(key)
        if (!is || is.expected === was.expected) continue
        // everything but the expected value must be untouched, or this is a rewrite
        if (is.context !== was.context) continue

        findings.push({
          id: '',
          class: 'verified',
          check: 'assertion-drift',
          severity: 'high',
          confidence: 'firm',
          file,
          line: is.line,
          span: is.span,
          title:
            'Expected value for `' + is.subject + '` changed from ' + was.expected + ' to ' + is.expected,
          evidence: {
            oracle: 'pre/post test AST',
            detail: 'the module this test covers did not change — the expectation moved with nothing it measures',
          },
          fix: 'Confirm the new value is correct behaviour, not the test being bent to fit the code',
        })
      }
    }
    return findings
  },
}
