import type { Finding, Ground, Verifier } from '#app/types.js'
import { nodesOfType, type LanguagePack, type Node } from '#app/lang/packs.js'
import { implementationFingerprint } from '#app/reinvention.js'
import {
  hasOtherExecutableChange,
  provenGuardRemovals,
  type GuardBlock,
  type GuardCallable,
} from './guard-diff.js'
import { declaredName, fileScopeIdentity, finding, sourceTokensFor, tokensFor } from './foreign-tokens.js'

type Callable = { name: string; node: Node; identity: string }

function bodyOf(root: Node, types: string[]): Node | undefined {
  const field = root.childForFieldName('body')
  if (field && types.includes(field.type)) return field
  for (const child of root.namedChildren) {
    if (types.includes(child.type)) return child
  }
  return undefined
}

function contractPart(node: Node, bodyTypes: string[], pack: LanguagePack): string {
  const body = bodyOf(node, bodyTypes)
  if (body) return node.type + ':' + implementationFingerprint(tokensFor(node, pack, body))
  const name = node.childForFieldName('name')
  return name
    ? node.type + ':name:' + implementationFingerprint(tokensFor(name, pack))
    : node.type + ':anonymous'
}

function callablesByIdentity(root: Node, pack: LanguagePack): Map<string, Callable[]> {
  const out = new Map<string, Callable[]>()
  const callableBodies = nodesOfType(root, pack.nodes.callable)
    .flatMap((node) => {
      const body = bodyOf(node, pack.nodes.callableBody)
      return body ? [body] : []
    })
  const moduleContract = 'module:' + implementationFingerprint(tokensFor(root, pack, callableBodies))

  const visit = (node: Node, context: string[]): void => {
    let currentContext = context
    if (pack.nodes.callableOwner.includes(node.type)) {
      currentContext = [...context, contractPart(node, pack.nodes.callableOwnerBody, pack)]
    }

    if (pack.nodes.callable.includes(node.type)) {
      const name = declaredName(node, pack)
      const body = bodyOf(node, pack.nodes.callableBody)
      if (name && body) {
        const part = contractPart(node, pack.nodes.callableBody, pack)
        const identity = [...currentContext, part].join('/')
        const list = out.get(identity) ?? []
        list.push({ name, node, identity })
        out.set(identity, list)
        // A nested callable belongs to this exact outer callable, not merely to a
        // same-named function elsewhere in the file.
        currentContext = [...currentContext, part]
      }
    }

    for (const child of node.namedChildren) visit(child, currentContext)
  }

  const fileScope = fileScopeIdentity(root, pack)
  visit(root, [moduleContract, ...(fileScope ? [fileScope] : [])])
  return out
}

function endsInBail(node: Node, pack: LanguagePack): boolean {
  if (pack.nodes.bail.includes(node.type)) return true
  const children = node.namedChildren.filter((child) => !pack.nodes.comment.includes(child.type))
  if (pack.nodes.block.includes(node.type)) {
    const last = children.at(-1)
    return last !== undefined && endsInBail(last, pack)
  }
  // Some grammars wrap a return expression in one expression-statement node.
  return children.length === 1 && endsInBail(children[0]!, pack)
}

function childForAnyField(node: Node, fields: string[]): Node | null {
  for (const field of fields) {
    const child = node.childForFieldName(field)
    if (child) return child
  }
  return null
}

function sameNode(left: Node, right: Node): boolean {
  return left.type === right.type &&
    left.startPosition.row === right.startPosition.row &&
    left.startPosition.column === right.startPosition.column &&
    left.endPosition.row === right.endPosition.row &&
    left.endPosition.column === right.endPosition.column
}

function guardOf(statement: Node, pack: LanguagePack): { key: string; label: string } | undefined {
  let conditional = statement
  while (!pack.nodes.ifStatement.includes(conditional.type)) {
    const children = conditional.namedChildren.filter((child) => !pack.nodes.comment.includes(child.type))
    if (children.length !== 1) return undefined
    conditional = children[0]!
  }
  const children = conditional.namedChildren.filter((child) => !pack.nodes.comment.includes(child.type))
  const condition = childForAnyField(conditional, pack.nodes.ifCondition) ?? children[0] ?? null
  const branch = childForAnyField(conditional, pack.nodes.ifBody) ?? children[1] ?? null
  if (!condition || !branch || !endsInBail(branch, pack)) return undefined
  if (childForAnyField(conditional, pack.nodes.ifAlternative)) return undefined
  // Postfix conditionals put the branch before the condition. Reject a real
  // alternative by identity, not by assuming every grammar orders children alike.
  if (children.some((child) => !sameNode(child, condition) && !sameNode(child, branch))) return undefined
  const polarity = conditional.type.includes('unless') ? 'unless' : 'if'
  return {
    key: polarity + '|' + implementationFingerprint(tokensFor(condition, pack)),
    label: condition.text.replace(/\s+/g, ' ').trim(),
  }
}

function proofOf(callable: Callable, pack: LanguagePack, root: Node): GuardCallable {
  const out: GuardBlock[] = []
  const statements = new Map<string, Node>()
  const visit = (node: Node, path: number[]): void => {
    // Nested callables have their own before/after identity. Including their blocks
    // in the parent could pair a moved continuation with the wrong lexical scope.
    if (node !== callable.node && pack.nodes.callable.includes(node.type)) return
    if (pack.nodes.block.includes(node.type)) {
      const blockPath = path.join('.')
      out.push({
        path: blockPath,
        entries: node.namedChildren
          .filter((child) => !pack.nodes.comment.includes(child.type))
          .map((statement, index) => {
            const id = blockPath + ':statement:' + index
            statements.set(id, statement)
            return {
              id,
              fingerprint: implementationFingerprint(tokensFor(statement, pack)),
              guard: guardOf(statement, pack),
            }
          }),
      })
    }
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index)
      if (child) visit(child, [...path, index])
    }
  }
  visit(callable.node, [])
  return {
    identity: callable.identity,
    blocks: out,
    residualFingerprint(omitted) {
      const excluded: Node[] = []
      for (const id of omitted) {
        const statement = statements.get(id)
        if (!statement) return undefined
        excluded.push(statement)
      }
      return implementationFingerprint(sourceTokensFor(root, pack, excluded))
    },
  }
}

/**
 * Report only the narrow deterministic case: a uniquely identified callable and
 * lexical block are unchanged except for deleting an unconditional early-exit guard.
 * Helper extraction, delegation, moved code, and overloaded names all abstain.
 */
export const foreignDroppedGuard: Verifier = {
  name: 'dropped-guard',
  needs: ['syntax', 'base'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const file of g.foreign) {
      if (!file.beforeTree) continue
      if (file.changed.beforePath && file.changed.beforePath !== file.path) continue
      if (hasOtherExecutableChange(g, file.path)) continue
      const before = callablesByIdentity(file.beforeTree.rootNode, file.pack)
      const after = callablesByIdentity(file.tree.rootNode, file.pack)

      for (const [identity, previous] of before) {
        const current = after.get(identity) ?? []
        // A duplicate contract is still ambiguous. Without types or symbol
        // resolution, choosing one declaration would turn ambiguity into fact.
        if (previous.length !== 1 || current.length !== 1) continue
        const prev = previous[0]!
        const now = current[0]!
        const dropped = provenGuardRemovals(
          proofOf(prev, file.pack, file.beforeTree.rootNode),
          proofOf(now, file.pack, file.tree.rootNode),
        )
        if (dropped.length === 0) continue

        findings.push(
          finding(file, now.node, {
            check: 'dropped-guard',
            severity: 'high',
            confidence: 'proven',
            title:
              dropped.map((d) => '`' + d + '`').join(' and ') + ' guarded ' + now.name + '() before this change and ' +
              (dropped.length > 1 ? 'are' : 'is') + ' gone',
            evidence: {
              oracle: file.pack.name + ' pre/post control-flow AST',
              detail: 'every other file token matches after removing only the guard, with no executable change in another source file',
            },
          }),
        )
      }
    }
    return findings
  },
}
