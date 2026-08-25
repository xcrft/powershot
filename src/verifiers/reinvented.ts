import { SyntaxKind, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, normalizeName, relPath } from '#app/ground.js'
import { createReinventionScopeResolver, typescriptImplementationFingerprint } from '#app/reinvention.js'

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

type Declared = { name: string; line: number; span: { column: number; length: number }; fingerprint: string }

function declaredNames(sf: SourceFile, bindingPath: string): Declared[] {
  const out: Declared[] = []
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    const id = fn.getNameNode()
    const fingerprint = typescriptImplementationFingerprint(fn, bindingPath)
    if (name && id && fingerprint) {
      out.push({ name, line: fn.getStartLineNumber(), span: locate(sf, id.getStart(), id.getWidth()).span, fingerprint })
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (!init) continue
    if (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression)) {
      const id = v.getNameNode()
      const fingerprint = typescriptImplementationFingerprint(v, bindingPath)
      if (fingerprint) {
        out.push({ name: v.getName(), line: v.getStartLineNumber(), span: locate(sf, id.getStart(), id.getWidth()).span, fingerprint })
      }
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
    const scopeFor = createReinventionScopeResolver(g.root)
    for (const { sf, changed, before } of g.files) {
      const file = relPath(sf, g.root)
      const scope = scopeFor(file)
      // a fixture builder repeated across test files is a deliberate trade, and two
      // tests describing the same scenario naturally share a name
      if (TEST_FILE.test(file)) continue
      const baseDeclarations = before ? declaredNames(before, changed.beforePath ?? file) : []
      for (const { name, line, span, fingerprint } of declaredNames(sf, file)) {
        if (!changed.added.has(line)) continue
        if (changed.beforePath && changed.beforePath !== changed.path) continue
        if (name.length < 6 || GENERIC.has(name) || GENERIC.has(name.toLowerCase())) continue
        const existedHere = baseDeclarations.some(
          (declaration) =>
            normalizeName(declaration.name) === normalizeName(name) &&
            declaration.fingerprint === fingerprint,
        )
        if (existedHere) continue

        const match = (g.symbolIndex.get(normalizeName(name)) ?? []).find(
          (symbol) =>
            symbol.file !== file &&
            symbol.existedInBase &&
            symbol.scope === scope &&
            symbol.fingerprint === fingerprint,
        )
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
          title: name + '() repeats the implementation at ' + match.file + ':' + match.name,
          evidence: {
            oracle: 'base export + callable token fingerprint',
            detail: 'token-identical implementation already exported from ' + match.file + ':' + match.line,
          },
          // Deliberately not an import statement: the correct specifier depends on the
          // repo's module resolution, and a wrong one would be exactly the kind of
          // confidently-wrong output this tool exists to catch.
          fix: 'Consider reusing ' + match.name + ' from ' + match.file + '; if the separation is intentional, keep the boundary explicit',
        })
      }
    }
    return findings
  },
}
