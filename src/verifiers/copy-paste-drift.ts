import { ts, Node, type SourceFile, type Statement } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

/** Below this a coincidental shape match means nothing. */
const MIN_TOKENS = 8

type Tok = { kind: ts.SyntaxKind; text: string }

function tokenize(code: string): Tok[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code)
  const out: Tok[] = []
  let token = scanner.scan()
  for (let i = 0; token !== ts.SyntaxKind.EndOfFileToken && i < 20_000; i++) {
    out.push({ kind: token, text: scanner.getTokenText() })
    token = scanner.scan()
  }
  return out
}

function missedRename(a: Tok[], b: Tok[]): { name: string; became: string[] } | undefined {
  if (a.length !== b.length || a.length < MIN_TOKENS) return undefined

  const mapping = new Map<string, Set<string>>()
  let renamedSomething = false

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.kind !== y.kind) return undefined // different shape — not a clone
    if (x.kind !== ts.SyntaxKind.Identifier) {
      // literals and punctuation must match exactly, or the blocks simply differ
      if (x.text !== y.text) return undefined
      continue
    }
    if (x.text !== y.text) renamedSomething = true
    const targets = mapping.get(x.text) ?? new Set<string>()
    targets.add(y.text)
    mapping.set(x.text, targets)
  }

  if (!renamedSomething) return undefined // an exact duplicate is a different concern

  for (const [name, targets] of mapping) {
    // The signature of a missed rename is that one occurrence changed and another
    // stayed behind, so the original name must be among the targets. Two different
    // things that merely share a name — a local `tests` beside a member `.tests` —
    // map to two *new* names, which is not a rename anyone forgot. Found by running
    // this check over its own repository.
    if (targets.size > 1 && targets.has(name)) return { name, became: [...targets] }
  }
  return undefined
}

function statementLists(sf: SourceFile): Statement[][] {
  const lists: Statement[][] = [sf.getStatements()]
  for (const block of sf.getDescendantsOfKind(ts.SyntaxKind.Block)) lists.push(block.getStatements())
  return lists
}

/** A block copied from the one above it with one identifier left behind. */
export const copyPasteDrift: Verifier = {
  name: 'copy-paste-drift',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    for (const { sf, changed } of g.files) {
      const file = relPath(sf, g.root)

      for (const statements of statementLists(sf)) {
        for (let i = 1; i < statements.length; i++) {
          const prev = statements[i - 1]!
          const curr = statements[i]!
          const line = curr.getStartLineNumber()
          if (!changed.added.has(line)) continue
          if (Node.isEmptyStatement(prev) || Node.isEmptyStatement(curr)) continue
          // Consecutive imports from the same package share a shape by nature — a
          // list of what a file uses is not a block anyone copied and half-renamed.
          if (Node.isImportDeclaration(curr) || Node.isExportDeclaration(curr)) continue

          const miss = missedRename(tokenize(prev.getText()), tokenize(curr.getText()))
          if (!miss) continue

          findings.push({
            id: '',
            class: 'verified',
            check: 'copy-paste-drift',
            severity: 'high',
            confidence: 'firm',
            file,
            line,
            span: locate(sf, curr.getStart(), Math.min(curr.getWidth(), 120)).span,
            title:
              'Copied from the statement above with `' +
              miss.name +
              '` renamed inconsistently — it became ' +
              miss.became.map((t) => '`' + t + '`').join(' in one place and ') +
              ' in another',
            evidence: {
              oracle: 'token stream',
              detail: 'both statements have identical shape and literals, so one identifier was left un-renamed',
            },
            fix: 'Rename the remaining `' + miss.name + '`, or extract the shared shape into a function',
          })
        }
      }
    }
    return findings
  },
}
