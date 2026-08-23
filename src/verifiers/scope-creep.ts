import { ts } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { relPath } from '#app/ground.js'

/**
 * The token stream a compiler would see: whitespace and comments dropped, everything
 * that changes behaviour kept. Two files with the same stream are the same program.
 */
function tokens(code: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.Standard, code)
  const out: string[] = []
  let token = scanner.scan()
  for (let i = 0; token !== ts.SyntaxKind.EndOfFileToken && i < 200_000; i++) {
    out.push(token + ':' + scanner.getTokenText())
    token = scanner.scan()
  }
  return out
}

/** Comment text only, to tell a comment-only edit from pure reformatting. */
function comments(code: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, code)
  const out: string[] = []
  let token = scanner.scan()
  for (let i = 0; token !== ts.SyntaxKind.EndOfFileToken && i < 200_000; i++) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      out.push(scanner.getTokenText().trim())
    }
    token = scanner.scan()
  }
  return out
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** A file the change touches without changing the program. */
export const scopeCreep: Verifier = {
  name: 'scope-creep',
  needs: ['syntax', 'base'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    for (const { sf, before } of g.files) {
      if (!before) continue // a new file always adds something

      const afterText = sf.getFullText()
      const beforeText = before.getFullText()
      if (afterText === beforeText) continue // not actually touched

      if (!same(tokens(beforeText), tokens(afterText))) continue // the program did change

      const commentsChanged = !same(comments(beforeText), comments(afterText))

      // Documentation is content. A change to JSDoc is API documentation someone
      // meant to write, and telling them to drop it from the change is wrong advice,
      // so only incidental comments and pure layout churn are reported. The same rule
      // applies in the tree-sitter implementation — one idea, one behaviour.
      if (commentsChanged && comments(afterText).some((c) => c.startsWith('/**'))) continue

      const what = commentsChanged ? 'only comments' : 'only formatting'

      findings.push({
        id: '',
        class: 'verified',
        check: 'scope-creep',
        severity: 'low',
        confidence: 'proven',
        file: relPath(sf, g.root),
        line: 1,
        title: 'This file changes ' + what + ' — the program it produces is identical',
        evidence: {
          oracle: 'token stream',
          detail: 'before and after tokenize identically once whitespace and comments are dropped',
        },
        fix: commentsChanged
          ? 'Keep it if the comments are the point; otherwise drop the file from the change'
          : 'Revert the reformatting so the diff shows the actual change',
      })
    }
    return findings
  },
}
