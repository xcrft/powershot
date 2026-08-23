import { Node, SyntaxKind } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

/** `process.env.FOO` and `process.env['FOO']` */
function envReads(sf: import('ts-morph').SourceFile): { name: string; line: number; start: number; width: number }[] {
  const out: { name: string; line: number; start: number; width: number }[] = []

  for (const access of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getExpression().getText() !== 'process.env') continue
    const id = access.getNameNode()
    out.push({ name: id.getText(), line: access.getStartLineNumber(), start: id.getStart(), width: id.getWidth() })
  }
  for (const access of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    if (access.getExpression().getText() !== 'process.env') continue
    const arg = access.getArgumentExpression()
    if (!arg || !Node.isStringLiteral(arg)) continue
    out.push({
      name: arg.getLiteralValue(),
      line: access.getStartLineNumber(),
      start: arg.getStart(),
      width: arg.getWidth(),
    })
  }
  return out
}

/**
 * Variables the platform sets, not the application.
 *
 * A terminal supplies COLUMNS, a CI runner supplies CI, the shell supplies HOME.
 * None of them belong in an application's env manifest, and reporting them made the
 * check accuse correct code of inventing configuration — measured on a whole-repo
 * scan, every one of these was a false positive.
 */
const PLATFORM = new Set([
  'CI', 'HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL',
  'COLUMNS', 'LINES', 'FORCE_COLOR', 'NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'DEBUG',
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_DEBUG', 'NODE_EXTRA_CA_CERTS', 'npm_lifecycle_event',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'GITHUB_ACTIONS', 'GITHUB_TOKEN', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'RUNNER_OS',
])

/** An environment variable the change reads that is declared nowhere. */
export const phantomConfig: Verifier = {
  name: 'phantom-config',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const manifest = g.envManifest
    if (!manifest) return []

    // a key used elsewhere in the codebase is a documentation gap, not an invention
    const usedElsewhere = new Set<string>()
    const changedPaths = new Set(g.changed.map((c) => c.path))
    for (const sf of g.project.getSourceFiles()) {
      const path = relPath(sf, g.root)
      if (changedPaths.has(path) || path.includes('node_modules')) continue
      for (const read of envReads(sf)) usedElsewhere.add(read.name)
    }

    const findings: Finding[] = []
    for (const { sf, changed } of g.files) {
      for (const read of envReads(sf)) {
        if (!changed.added.has(read.line)) continue
        if (manifest.keys.has(read.name) || usedElsewhere.has(read.name)) continue
        if (PLATFORM.has(read.name)) continue

        findings.push({
          id: '',
          class: 'verified',
          check: 'phantom-config',
          severity: 'medium',
          // The manifest is not the process environment. What the oracle settles is
          // that nothing in the repository declares or uses this key — a deployment
          // can still set it, so "will be undefined" is an inference, not a fact.
          confidence: 'firm',
          file: relPath(sf, g.root),
          line: read.line,
          span: locate(sf, read.start, read.width).span,
          title:
            'Reads process.env.' + read.name + ', which is not declared in ' + manifest.file + ' or used anywhere else',
          evidence: {
            oracle: manifest.file,
            detail: 'the key appears in no manifest entry and in no other source file',
          },
          fix: 'Add ' + read.name + ' to ' + manifest.file + ', or drop the reference if it was invented',
        })
      }
    }
    return findings
  },
}
