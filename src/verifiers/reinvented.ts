import { SyntaxKind, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, normalizeName, relPath } from '#app/ground.js'

/**
 * Names too generic to mean anything across files — two `render`s are usually
 * two different things, not a duplication.
 */
const TEST_FILE = /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/

const GENERIC = new Set([
  'render', 'index', 'main', 'run', 'get', 'set', 'init', 'setup', 'start', 'stop',
  'handler', 'handle', 'create', 'update', 'remove', 'delete', 'list', 'find',
  'parse', 'format', 'load', 'save', 'toString', 'default', 'config', 'options',
])

type Declared = { name: string; line: number; span: { column: number; length: number } }

function declaredNames(sf: SourceFile): Declared[] {
  const out: Declared[] = []
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    const id = fn.getNameNode()
    if (name && id) out.push({ name, line: fn.getStartLineNumber(), span: locate(sf, id.getStart(), id.getWidth()).span })
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression)) {
      const id = v.getNameNode()
      out.push({ name: v.getName(), line: v.getStartLineNumber(), span: locate(sf, id.getStart(), id.getWidth()).span })
    }
  }
  return out
}

/** A helper the change introduces that already exists elsewhere in the repo. */
export const reinvented: Verifier = {
  name: 'reinvented',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const { sf, changed } of g.files) {
      const file = relPath(sf, g.root)
      // a fixture builder repeated across test files is a deliberate trade, and two
      // tests describing the same scenario naturally share a name
      if (TEST_FILE.test(file)) continue
      for (const { name, line, span } of declaredNames(sf)) {
        if (!changed.added.has(line)) continue
        if (name.length < 6 || GENERIC.has(name) || GENERIC.has(name.toLowerCase())) continue

        const existing = (g.symbolIndex.get(normalizeName(name)) ?? []).filter((s) => s.file !== file)
        const match = existing[0]
        if (!match) continue

        findings.push({
          id: '',
          class: 'verified',
          check: 'reinvented',
          severity: 'medium',
          confidence: 'firm',
          file,
          line,
          span,
          title: name + '() duplicates an existing export ' + match.file + ':' + match.name,
          evidence: { oracle: 'repo symbol index', detail: 'already exported from ' + match.file + ':' + match.line },
          // Deliberately not an import statement: the correct specifier depends on the
          // repo's module resolution, and a wrong one would be exactly the kind of
          // confidently-wrong output this tool exists to catch.
          fix: 'Reuse ' + match.name + ' from ' + match.file + ' instead of redeclaring it',
        })
      }
    }
    return findings
  },
}
