import type { Finding, ForeignFile, Ground, Verifier } from '#app/types.js'
import type { Node } from '#app/lang/packs.js'

const TEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test)\.[a-z]+$|(^|\/)tests?\//

function at(file: ForeignFile, node: Node, f: Omit<Finding, 'id' | 'class' | 'file' | 'line' | 'span'>): Finding {
  return {
    id: '',
    class: 'verified',
    file: file.path,
    line: node.startPosition.row + 1,
    span: { column: node.startPosition.column + 1, length: Math.min(node.text.split('\n')[0]?.length ?? 1, 80) },
    ...f,
  }
}

/** A test that runs code and proves nothing. */
export const foreignVacuousTest: Verifier = {
  name: 'vacuous-test',
  needs: ['syntax'],
  supports: (file) => file.pack.tests !== undefined && TEST_FILE.test(file.path),
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const file of g.foreign) {
      if (!file.pack.tests || !TEST_FILE.test(file.path)) continue

      for (const test of file.pack.tests(file.tree.rootNode)) {
        const line = test.node.startPosition.row + 1
        if (!file.changed.added.has(line) || !test.provesNothing) continue

        findings.push(
          at(file, test.node, {
            check: 'vacuous-test',
            severity: 'high',
            confidence: 'proven',
            title: test.name + ' runs code but asserts nothing',
            evidence: {
              oracle: file.pack.name + ' test AST',
              detail: 'no assert, no assertion method, and no raises block anywhere in the body',
            },
          }),
        )
      }
    }
    return findings
  },
}

/** The enclosing test with the expected value blanked out. */
function contextOf(test: Node, expectedNode: Node): string {
  const text = test.text
  const offset = expectedNode.startPosition.row - test.startPosition.row
  const lines = text.split('\n')
  const line = lines[offset]
  if (line === undefined) return text.replace(/\s+/g, ' ').trim()

  const column =
    expectedNode.startPosition.row === test.startPosition.row
      ? expectedNode.startPosition.column - test.startPosition.column
      : expectedNode.startPosition.column
  lines[offset] = line.slice(0, column) + '\u0000' + line.slice(column + expectedNode.text.length)
  return lines.join('\n').replace(/\s+/g, ' ').trim()
}

/** An expected value edited to match new output. */
export const foreignAssertionDrift: Verifier = {
  name: 'assertion-drift',
  needs: ['syntax', 'base'],
  supports: (file) => file.pack.tests !== undefined && TEST_FILE.test(file.path),
  run(g: Ground): Finding[] {
    const changedModules = new Set(
      g.changed
        .map((f) => f.path)
        .filter((p) => !TEST_FILE.test(p))
        .map((p) => (p.split('/').pop() ?? '').replace(/\.[a-z]+$/, '')),
    )

    const findings: Finding[] = []
    for (const file of g.foreign) {
      if (!file.pack.tests || !file.beforeTree || !TEST_FILE.test(file.path)) continue

      const subject = (file.path.split('/').pop() ?? '')
        .replace(/\.[a-z]+$/, '')
        .replace(/^test_/, '')
        .replace(/_test$/, '')
      if (changedModules.has(subject)) continue

      const now = new Map<string, { expected: string; node: Node; expectedNode: Node; test: Node }>()
      for (const t of file.pack.tests(file.tree.rootNode)) {
        for (const a of t.assertions) {
          now.set(t.name + '|' + a.subject, { expected: a.expected, node: a.node, expectedNode: a.expectedNode, test: t.node })
        }
      }

      for (const t of file.pack.tests(file.beforeTree.rootNode)) {
        for (const a of t.assertions) {
          const is = now.get(t.name + '|' + a.subject)
          if (!is || is.expected === a.expected) continue
          if (contextOf(is.test, is.expectedNode) !== contextOf(t.node, a.expectedNode)) continue

          findings.push(
            at(file, is.node, {
              check: 'assertion-drift',
              severity: 'high',
              confidence: 'firm',
              title: 'Expected value for `' + a.subject + '` changed from ' + a.expected + ' to ' + is.expected,
              evidence: {
                oracle: file.pack.name + ' pre/post test AST',
                detail: 'the module this test covers did not change — the expectation moved with nothing it measures',
              },
              fix: 'Confirm the new value is correct behaviour, not the test being bent to fit the code',
            }),
          )
        }
      }
    }
    return findings
  },
}

/** Documentation that contradicts the signature it sits on. */
export const foreignLyingComment: Verifier = {
  name: 'lying-comment',
  needs: ['syntax'],
  supports: (file) => file.pack.documentedParams !== undefined,
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const file of g.foreign) {
      if (!file.pack.documentedParams) continue

      for (const doc of file.pack.documentedParams(file.tree.rootNode)) {
        for (const documented of doc.documented) {
          const line = documented.node.startPosition.row + 1
          if (!file.changed.added.has(line)) continue
          if (doc.declared.includes(documented.name)) continue

          findings.push(
            at(file, documented.node, {
              check: 'lying-comment',
              severity: 'medium',
              confidence: 'proven',
              title:
                'The docstring documents `' +
                documented.name +
                '`, which ' +
                doc.fn +
                '() does not take (' +
                (doc.declared.length > 0 ? 'it takes ' + doc.declared.join(', ') : 'it takes none') +
                ')',
              evidence: { oracle: 'signature', detail: 'the documented name is not in the parameter list' },
              fix: 'Update the docstring to the real parameters, or restore the argument it describes',
            }),
          )
        }
      }
    }
    return findings
  },
}

export const FOREIGN_TEST_VERIFIERS: Verifier[] = [foreignVacuousTest, foreignAssertionDrift, foreignLyingComment]
