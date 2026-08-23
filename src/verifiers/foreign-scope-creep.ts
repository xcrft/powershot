import type { Finding, Ground, Verifier } from '#app/types.js'
import { commentText, documentsSomething, finding, same, tokensFor } from './foreign-tokens.js'
import type { LanguagePack, Node } from '#app/lang/packs.js'

/**
 * Token-only, so it is the same check in every language: git says the file changed,
 * the token stream says the program did not.
 */
export const foreignScopeCreep: Verifier = {
  name: 'scope-creep',
  needs: ['syntax', 'base'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const file of g.foreign) {
      if (!file.beforeTree) continue
      const after = file.tree.rootNode
      const before = file.beforeTree.rootNode
      if (after.text === before.text) continue
      if (!same(tokensFor(before, file.pack), tokensFor(after, file.pack))) continue

      // Documentation is content. A change to `///` in Rust, a docstring in Python or
      // a doc block anywhere is published API documentation someone meant to write,
      // and telling them to revert it is wrong advice — so only pure layout churn is
      // reported as something to undo.
      const commentsChanged = commentText(before, file.pack) !== commentText(after, file.pack)
      if (commentsChanged && documentsSomething(after, file.pack)) continue

      findings.push(
        finding(file, after, {
          check: 'scope-creep',
          severity: 'low',
          confidence: 'proven',
          title:
            'This file changes only ' + (commentsChanged ? 'comments' : 'formatting') +
            ' — the program it produces is identical',
          evidence: { oracle: file.pack.name + ' token stream', detail: 'before and after tokenize identically' },
          fix: commentsChanged
            ? 'Keep it if the comments are the point; otherwise drop the file from the change'
            : 'Revert the reformatting so the diff shows the actual change',
        }),
      )
    }
    return findings
  },
}
