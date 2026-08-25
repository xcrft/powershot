import { Node, SyntaxKind, type SourceFile } from 'ts-morph'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { locate, relPath } from '#app/ground.js'
import { typescriptSourceFingerprint, typescriptTokenFingerprint } from '#app/reinvention.js'
import {
  hasOtherExecutableChange,
  provenGuardRemovals,
  type GuardBlock,
  type GuardCallable,
} from './guard-diff.js'

type Fn = { name: string; node: Node; identity: string }
type Functions = Map<string, Fn[]>

function fingerprintWithoutRange(root: Node, start: number, end: number, marker: string): string | undefined {
  const source = root.getFullText()
  const rootStart = root.getFullStart()
  return typescriptSourceFingerprint(source.slice(0, start - rootStart) + marker + source.slice(end - rootStart))
}

function fingerprintWithoutRanges(root: Node, ranges: Node[], marker: string): string | undefined {
  const source = root.getFullText()
  const rootStart = root.getFullStart()
  const ordered = [...ranges].sort((left, right) => left.getStart() - right.getStart())
  const parts: string[] = []
  let cursor = 0
  for (const range of ordered) {
    const start = range.getFullStart() - rootStart
    const end = range.getEnd() - rootStart
    if (start < cursor) continue
    parts.push(source.slice(cursor, start), marker)
    cursor = end
  }
  parts.push(source.slice(cursor))
  return typescriptSourceFingerprint(parts.join(''))
}

function fingerprintWithoutBody(identityNode: Node, body: Node): string | undefined {
  return fingerprintWithoutRange(identityNode, body.getStart(), body.getEnd(), '__powershot_body__')
}

function callable(
  name: string,
  node: Node,
  moduleContract: string,
  identityNode: Node = node,
  owner = '',
): Fn | undefined {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node) &&
    !Node.isArrowFunction(node) &&
    !Node.isFunctionExpression(node)
  ) return undefined
  const body = node.getBody()
  if (!body) return undefined
  const fingerprint = fingerprintWithoutBody(identityNode, body)
  return fingerprint ? { name, node, identity: moduleContract + '|' + owner + '|' + name + '|' + fingerprint } : undefined
}

function classContract(node: Node): string | undefined {
  if (!Node.isClassDeclaration(node)) return undefined
  const members = node.getMembers()
  const first = members[0]
  const last = members.at(-1)
  if (!first || !last) return typescriptTokenFingerprint(node.getText())
  return fingerprintWithoutRange(node, first.getStart(), last.getEnd(), '__powershot_members__')
}

function moduleContract(source: SourceFile): string | undefined {
  const bodies: Node[] = []
  for (const declaration of source.getFunctions()) {
    const body = declaration.getBody()
    if (body) bodies.push(body)
  }
  for (const declaration of source.getClasses()) {
    for (const method of declaration.getMethods()) {
      const body = method.getBody()
      if (body) bodies.push(body)
    }
  }
  for (const declaration of source.getVariableDeclarations()) {
    const initializer = declaration.getInitializer()
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      bodies.push(initializer.getBody())
    }
  }
  return fingerprintWithoutRanges(source, bodies, '__powershot_callable_body__')
}

function functionsOf(sf: SourceFile): Fn[] {
  const out: Fn[] = []
  const module = moduleContract(sf)
  if (!module) return out
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    const found = name ? callable(name, fn, module) : undefined
    if (found) out.push(found)
  }
  for (const cls of sf.getClasses()) {
    const prefix = (cls.getName() ?? 'anonymous') + '.'
    const owner = classContract(cls)
    if (!owner) continue
    for (const m of cls.getMethods()) {
      const found = callable(prefix + m.getName(), m, module, m, owner)
      if (found) out.push(found)
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    if (init?.isKind(SyntaxKind.ArrowFunction) || init?.isKind(SyntaxKind.FunctionExpression)) {
      const found = callable(v.getName(), init, module, v)
      if (found) out.push(found)
    }
  }
  return out
}

function functionsByName(sf: SourceFile): Functions {
  const out: Functions = new Map()
  for (const fn of functionsOf(sf)) {
    const list = out.get(fn.name) ?? []
    list.push(fn)
    out.set(fn.name, list)
  }
  return out
}

/** collapse whitespace so reformatting alone never reads as a dropped guard */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A guard is an `if` whose branch bails out — throw, return, continue, or break.
 * That shape is what protects the code below it, so losing one changes behaviour.
 */
function guardOf(statement: Node): { key: string; label: string } | undefined {
  if (!Node.isIfStatement(statement)) return undefined
  if (statement.getElseStatement()) return undefined
  const branch = statement.getThenStatement()
  const directBail = (node: Node): boolean =>
    node.isKind(SyntaxKind.ThrowStatement) ||
    node.isKind(SyntaxKind.ReturnStatement) ||
    node.isKind(SyntaxKind.ContinueStatement) ||
    node.isKind(SyntaxKind.BreakStatement)
  const last = Node.isBlock(branch) ? branch.getStatements().at(-1) : branch
  if (!last || !directBail(last)) return undefined
  const expression = statement.getExpression()
  const fingerprint = typescriptTokenFingerprint(expression.getText())
  return fingerprint ? { key: 'if|' + fingerprint, label: normalize(expression.getText()) } : undefined
}

function proofOf(fn: Fn): GuardCallable {
  const statements = new Map<string, Node>()
  const blocks: GuardBlock[] = []
  for (const block of fn.node.getDescendantsOfKind(SyntaxKind.Block)) {
    if (!belongsTo(fn.node, block)) continue
    const entries: GuardBlock['entries'] = []
    let complete = true
    for (const statement of block.getStatements()) {
      const id = pathFrom(fn.node, statement)
      const fingerprint = typescriptTokenFingerprint(statement.getText())
      if (!id || !fingerprint) {
        complete = false
        break
      }
      statements.set(id, statement)
      entries.push({ id, fingerprint, guard: guardOf(statement) })
    }
    if (complete) blocks.push({ path: pathFrom(fn.node, block), entries })
  }
  return {
    identity: fn.identity,
    blocks,
    residualFingerprint(omitted) {
      const ranges: Node[] = []
      for (const id of omitted) {
        const statement = statements.get(id)
        if (!statement) return undefined
        ranges.push(statement)
      }
      return fingerprintWithoutRanges(fn.node.getSourceFile(), ranges, '')
    },
  }
}

function belongsTo(root: Node, node: Node): boolean {
  let current = node.getParent()
  while (current && current !== root) {
    if (Node.isFunctionLikeDeclaration(current)) return false
    current = current.getParent()
  }
  return current === root
}

function pathFrom(root: Node, node: Node): string {
  const path: number[] = []
  let current: Node | undefined = node
  while (current && current !== root) {
    const parent = current.getParent()
    if (!parent) return ''
    path.push(current.getChildIndex())
    current = parent
  }
  return path.reverse().join('.')
}

/**
 * The pre/post AST pair proves only a guard-only deletion from the same callable and
 * lexical block. Refactors that move or change the continuation deliberately abstain.
 */
export const droppedGuard: Verifier = {
  name: 'dropped-guard',
  needs: ['syntax', 'base'],
  run(g: Ground): Finding[] {
    const findings: Finding[] = []
    for (const { sf, before, changed } of g.files) {
      if (!before) continue // a new file cannot have dropped anything
      const file = relPath(sf, g.root)
      if (changed.beforePath && changed.beforePath !== changed.path) continue
      if (hasOtherExecutableChange(g, file)) continue

      const after = functionsByName(sf)
      for (const [name, previous] of functionsByName(before)) {
        const current = after.get(name) ?? []
        if (previous.length !== 1 || current.length !== 1) continue
        const prev = previous[0]!
        const now = current[0]!

        const dropped = provenGuardRemovals(proofOf(prev), proofOf(now))
        if (dropped.length === 0) continue

        // one finding per function, not per guard: several guards lost in the same
        // rewrite are one fact about one place, and repeating the line is noise
        findings.push({
          id: '',
          class: 'verified',
          check: 'dropped-guard',
          severity: 'high',
          confidence: 'proven',
          file,
          line: now.node.getStartLineNumber(),
          span: locate(sf, now.node.getStart(), Math.min(now.node.getWidth(), 80)).span,
          title:
            dropped.map((d) => '`if (' + d + ')`').join(' and ') +
            ' ' + (dropped.length > 1 ? 'were' : 'was') +
            ' present in ' + name + '() before this change and ' + (dropped.length > 1 ? 'are' : 'is') + ' gone',
          evidence: {
            oracle: 'pre/post control-flow AST',
            detail: 'every other file token matches after removing only the guard, with no executable change in another source file',
          },
        })
      }
    }
    return findings
  },
}
