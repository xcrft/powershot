import { builtinModules } from 'node:module'
import { SyntaxKind } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

const BUILTIN = new Set(builtinModules)

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name` */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

/**
 * A URL-scheme specifier is not an npm manifest entry at all — Deno and Bun resolve
 * `jsr:`, `npm:` and http imports themselves, so package.json can never declare them.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/

/**
 * `@/i18n` is not an npm package and never can be: a scoped name requires a scope,
 * so an empty one (`@/`) is structurally invalid. Every repo that writes it means a
 * local path alias, whichever tsconfig happens to declare it.
 * A `#name` specifier is a private package import resolved through `package.json`.
 */
function isBare(specifier: string): boolean {
  if (specifier.startsWith('@/') || specifier.startsWith('#')) return false
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !SCHEME.test(specifier)
}

/**
 * An import of a package that is not declared anywhere in the manifest.
 * The manifest is the oracle, so this is proven — but only when we managed to
 * read one, otherwise every import would look phantom.
 */
export const phantomDep: Verifier = {
  name: 'phantom-dep',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const { sf, changed } of g.files) {
      const deps = g.depsFor(sf.getFilePath())
      if (deps.size === 0) continue // no manifest governs this file — nothing to claim

      // a specifier the compiler resolves to repo source is internal, whatever it
      // looks like: a tsconfig alias, a workspace package, a path mapping
      const internal = new Set<string>()
      for (const imp of sf.getImportDeclarations()) {
        const resolved = imp.getModuleSpecifierSourceFile()
        if (resolved && !resolved.getFilePath().includes('/node_modules/')) {
          internal.add(imp.getModuleSpecifierValue())
        }
      }

      const specifiers: { text: string; line: number; span?: { column: number; length: number } }[] = []

      for (const imp of sf.getImportDeclarations()) {
        const node = imp.getModuleSpecifier()
        specifiers.push({
          text: imp.getModuleSpecifierValue(),
          line: imp.getStartLineNumber(),
          span: locate(sf, node.getStart(), node.getWidth()).span,
        })
      }
      for (const exp of sf.getExportDeclarations()) {
        const value = exp.getModuleSpecifierValue()
        const node = exp.getModuleSpecifier()
        if (value && node) {
          specifiers.push({ text: value, line: exp.getStartLineNumber(), span: locate(sf, node.getStart(), node.getWidth()).span })
        }
      }
      // require('x') and import('x')
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression().getText()
        if (callee !== 'require' && callee !== 'import') continue
        const arg = call.getArguments()[0]
        if (arg?.isKind(SyntaxKind.StringLiteral)) {
          specifiers.push({
            text: arg.getLiteralValue(),
            line: call.getStartLineNumber(),
            span: locate(sf, arg.getStart(), arg.getWidth()).span,
          })
        }
      }

      for (const { text, line, span } of specifiers) {
        if (!changed.added.has(line)) continue
        if (!isBare(text)) continue
        // a tsconfig path alias looks like a package and resolves to local source
        if (g.internalPrefixes.some((prefix) => text.startsWith(prefix))) continue
        if (internal.has(text)) continue
        const pkg = packageOf(text)
        if (BUILTIN.has(pkg) || deps.has(pkg)) continue
        findings.push({
          id: '',
          class: 'verified',
          check: 'phantom-dep',
          severity: 'high',
          confidence: 'proven',
          file: relPath(sf, g.root),
          line,
          span,
          title: 'Imports "' + pkg + '", which is not a declared dependency',
          evidence: { oracle: 'package.json', detail: 'not found in dependencies, devDependencies, peerDependencies, or optionalDependencies' },
          fix: 'npm install ' + pkg + ' — or remove the import if it was invented',
        })
      }
    }
    return findings
  },
}
