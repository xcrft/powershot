import { SyntaxKind, type Node, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(__tests__\/)/
const TEST_FN = /^(it|test)(\.(only|each|concurrent))?$/
/** assertion styles across jest / vitest / node:test / chai / ava */
const ASSERTION = /^(expect|assert|assert\.\w+|t\.\w+|chai\.\w+|should)/

/**
 * End-to-end suites put their assertions in page objects, so the test body calls
 * `page.verifySomething()` and contains no `expect` of its own. A method named for
 * checking is an assertion by intent, and treating it otherwise reported four
 * perfectly good Playwright tests on a real repository.
 */
const DELEGATED_ASSERTION = /(^|\.)(verify|assert|expect|should|check|confirm)[A-Z_]/

function isTestFile(path: string): boolean {
  return TEST_FILE.test(path)
}

/** `src/a/useThing.test.ts` -> `useThing`: what this file claims to be testing. */
function subjectOf(testPath: string): string | undefined {
  const base = testPath.split('/').pop() ?? ''
  const match = /^(.+?)\.(test|spec)\.[cm]?[jt]sx?$/.exec(base)
  return match?.[1]
}

/** `../../services/itsmScraper` -> `itsmScraper` */
function moduleBase(specifier: string): string {
  return (specifier.split('/').pop() ?? specifier).replace(/\.[cm]?[jt]sx?$/, '')
}

function assertsSomething(body: Node): boolean {
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const text = call.getExpression().getText()
    if (ASSERTION.test(text) || DELEGATED_ASSERTION.test(text)) return true
    // fluent styles: expect(x).toBe(y) is caught above; value.should.equal(y) is not
    if (/\.should\b/.test(text)) return true
  }
  return false
}

/**
 * Module specifiers passed to jest.mock / vi.mock, with where each one sits so the
 * caret can mark the string itself.
 */
function mockedModules(sf: SourceFile): Map<string, { line: number; span: { column: number; length: number } }> {
  const out = new Map<string, { line: number; span: { column: number; length: number } }>()
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText()
    if (callee !== 'jest.mock' && callee !== 'vi.mock' && callee !== 'mock.module') continue
    const arg = call.getArguments()[0]
    if (arg?.isKind(SyntaxKind.StringLiteral)) {
      out.set(arg.getLiteralValue(), {
        line: call.getStartLineNumber(),
        span: locate(sf, arg.getStart(), arg.getWidth()).span,
      })
    }
  }
  return out
}

/**
 * Two ways a test can look like proof and be none:
 * 1. it runs code and asserts nothing
 * 2. it mocks the very module it imports its subject from, so it asserts on the mock
 */
export const vacuousTest: Verifier = {
  name: 'vacuous-test',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    for (const { sf, changed } of g.files) {
      const file = relPath(sf, g.root)
      if (!isTestFile(file)) continue

      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!TEST_FN.test(call.getExpression().getText())) continue
        const line = call.getStartLineNumber()
        if (!changed.added.has(line)) continue

        const body = call.getArguments()[1]
        if (!body) continue // it('todo') with no callback is a placeholder, not a lie
        const block = body.getFirstDescendantByKind(SyntaxKind.Block) ?? body
        if (block.getDescendantsOfKind(SyntaxKind.CallExpression).length === 0) continue // empty body

        if (!assertsSomething(block)) {
          const title = call.getArguments()[0]?.getText() ?? 'test'
          findings.push({
            id: '',
            class: 'verified',
            check: 'vacuous-test',
            severity: 'high',
            confidence: 'proven',
            file,
            line,
            span: locate(sf, call.getExpression().getStart(), call.getExpression().getWidth()).span,
            title: 'Test ' + title + ' runs code but asserts nothing',
            evidence: { oracle: 'test AST', detail: 'no expect/assert call anywhere in the test body' },
          })
        }
      }

      // Mocking the unit under test — not merely mocking a dependency, which is
      // ordinary practice. The subject is the module the test file is named after:
      // useItsmScraping.test.ts tests useItsmScraping, so mocking @lakeside/ui-sdk
      // there is a stubbed collaborator, not a self-mocking test.
      const subjectName = subjectOf(file)
      if (!subjectName) continue
      const mocked = mockedModules(sf)
      if (mocked.size === 0) continue
      for (const imp of sf.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue()
        const mock = mocked.get(spec)
        if (mock === undefined) continue
        if (moduleBase(spec) !== subjectName) continue
        const names = imp.getNamedImports().map((n) => n.getName())
        const subject = names[0] ?? imp.getDefaultImport()?.getText()
        if (!subject) continue
        findings.push({
          id: '',
          class: 'verified',
          check: 'vacuous-test',
          severity: 'high',
          confidence: 'proven',
          file,
          line: mock.line,
          span: mock.span,
          title: 'Test mocks "' + spec + '", the module it imports ' + subject + ' from — it asserts on the mock',
          evidence: { oracle: 'test AST', detail: 'the mocked specifier is also the import source of the unit under test' },
        })
      }
    }
    return findings
  },
}
