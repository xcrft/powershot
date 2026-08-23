import { Node, type JSDocableNode, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'

type Documented = {
  node: JSDocableNode & Node
  name: string
  params: string[]
  /** false when a destructured parameter makes name matching unreliable */
  paramsReliable: boolean
  returns: string
}

function documentedFunctions(sf: SourceFile): Documented[] {
  const out: Documented[] = []

  const collect = (node: Node, name: string): void => {
    if (!Node.isJSDocable(node)) return
    if (node.getJsDocs().length === 0) return
    if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node)) return

    const params = node.getParameters()
    out.push({
      node,
      name,
      params: params.map((p) => p.getName()),
      paramsReliable: params.every((p) => Node.isIdentifier(p.getNameNode())),
      returns: node.getReturnTypeNode()?.getText() ?? '',
    })
  }

  for (const fn of sf.getFunctions()) collect(fn, fn.getName() ?? 'function')
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) collect(m, (cls.getName() ?? '') + '.' + m.getName())
  }
  return out
}

const VOID_RETURN = new Set(['void', 'Promise<void>', 'never'])

/** Documentation that contradicts the code it sits on. */
export const lyingComment: Verifier = {
  name: 'lying-comment',
  needs: ['syntax'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []

    for (const { sf, changed } of g.files) {
      const file = relPath(sf, g.root)

      for (const fn of documentedFunctions(sf)) {
        for (const doc of fn.node.getJsDocs()) {
          for (const tag of doc.getTags()) {
            const line = tag.getStartLineNumber()
            if (!changed.added.has(line)) continue
            const tagName = tag.getTagName()

            if (fn.paramsReliable && Node.isJSDocParameterTag(tag) ) {
              // `@param options.retries` documents a property of a real parameter
              const root = tag.getName().split('.')[0] ?? ''
              if (root !== '' && !fn.params.includes(root)) {
                findings.push({
                  id: '',
                  class: 'verified',
                  check: 'lying-comment',
                  severity: 'medium',
                  confidence: 'proven',
                  file,
                  line,
                  span: locate(sf, tag.getStart(), tag.getWidth()).span,
                  title:
                    '@param `' + root + '` documents an argument ' + fn.name + '() does not take (' +
                    (fn.params.length > 0 ? 'it takes ' + fn.params.join(', ') : 'it takes none') + ')',
                  evidence: { oracle: 'signature', detail: 'the documented name is not in the parameter list' },
                  fix: 'Update the doc to the real parameters, or restore the argument it describes',
                })
              }
            }

            if ((tagName === 'returns' || tagName === 'return') && VOID_RETURN.has(fn.returns)) {
              const text = tag.getCommentText()?.trim() ?? ''
              if (text !== '') {
                findings.push({
                  id: '',
                  class: 'verified',
                  check: 'lying-comment',
                  severity: 'medium',
                  confidence: 'proven',
                  file,
                  line,
                  span: locate(sf, tag.getStart(), tag.getWidth()).span,
                  title: '@returns describes a value, but ' + fn.name + '() is declared to return ' + fn.returns,
                  evidence: { oracle: 'signature', detail: 'the declared return type yields nothing to return' },
                  fix: 'Drop the @returns, or return the value the doc promises',
                })
              }
            }
          }
        }
      }
    }
    return findings
  },
}
