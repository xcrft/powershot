import type { Finding, ForeignFile } from '#app/types.js'
import { posix } from 'node:path'
import { nodesOfType, walk, type LanguagePack, type Node } from '#app/lang/packs.js'
import { implementationFingerprint } from '#app/reinvention.js'

export type Tok = { type: string; text: string }

/**
 * Some wasm grammars leave meaningful text outside child nodes: Rust/Go string
 * contents and Kotlin's nullable `?` are examples. Keep those enclosing nodes atomic
 * so a value or contract change cannot disappear from the fingerprint.
 */
const ATOMIC = /string|char|raw_|heredoc|interpolat|nullable_type/

/** The token stream: what a compiler sees, minus layout and comments. */
function nodeKey(node: Node): string {
  return [
    node.type,
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  ].join(':')
}

export function tokensFor(root: Node, pack: LanguagePack, exclude?: Node | readonly Node[]): Tok[] {
  const out: Tok[] = []
  const excluded = new Set(
    (exclude === undefined ? [] : Array.isArray(exclude) ? exclude : [exclude]).map(nodeKey),
  )
  const visit = (n: Node): void => {
    if (excluded.has(nodeKey(n))) return
    if (pack.nodes.comment.includes(n.type)) return
    if (ATOMIC.test(n.type)) {
      out.push({ type: n.type, text: n.text })
      return // atomic: never descend, so the content is compared whole
    }
    if (n.childCount === 0) {
      if (n.text.trim() !== '') out.push({ type: n.type, text: n.text })
      return
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i)
      if (child) visit(child)
    }
  }
  visit(root)
  return out
}

/** Tokens that affect compilation, including comment-shaped file constraints. */
export function sourceTokensFor(
  root: Node,
  pack: LanguagePack,
  exclude?: Node | readonly Node[],
): Tok[] {
  return [
    ...(pack.fileConstraints?.(root) ?? []).map((text) => ({ type: '__file_constraint__', text })),
    ...tokensFor(root, pack, exclude),
  ]
}

export function commentText(root: Node, pack: LanguagePack): string {
  const parts: string[] = []
  walk(root, (n) => {
    if (pack.nodes.comment.includes(n.type)) parts.push(n.text.trim())
  })
  return parts.join('\n')
}

/** Doc comments — `///`, `//!`, JSDoc-style blocks — are documentation, not an aside. */
export function documentsSomething(root: Node, pack: LanguagePack): boolean {
  let found = false
  walk(root, (n) => {
    if (!pack.nodes.comment.includes(n.type)) return
    const t = n.text.trimStart()
    if (t.startsWith('///') || t.startsWith('//!') || t.startsWith('/**') || t.startsWith('#:')) found = true
  })
  return found
}

export function same(a: Tok[], b: Tok[]): boolean {
  return a.length === b.length && a.every((t, i) => t.type === b[i]!.type && t.text === b[i]!.text)
}

/** Layout-insensitive identity of a file's declared package/module, when it has one. */
export function fileScopeIdentity(root: Node, pack: LanguagePack): string | undefined {
  const tokens = root.namedChildren
    .filter((child) => pack.nodes.fileScope.includes(child.type))
    .flatMap((child) => tokensFor(child, pack))
  const constraints = pack.fileConstraints?.(root) ?? []
  return tokens.length === 0 && constraints.length === 0
    ? undefined
    : 'file:' + JSON.stringify({ tokens, constraints })
}

export function finding(file: ForeignFile, node: Node, f: Omit<Finding, 'id' | 'class' | 'file' | 'line' | 'span'>): Finding {
  return {
    id: '',
    class: 'verified',
    file: file.path,
    line: node.startPosition.row + 1,
    span: { column: node.startPosition.column + 1, length: Math.min(node.text.split('\n')[0]?.length ?? 1, 90) },
    ...f,
  }
}

/**
 * The grammar's name field is authoritative whatever node type it is — Rust names a
 * struct `type_identifier`. Second-guessing it by node type once returned `static`.
 */
export function declaredName(decl: Node, pack: LanguagePack): string | undefined {
  const field = decl.childForFieldName(pack.nodes.declarationName)
  // tree-sitter-kotlin exposes the declaration identifier as a named child but
  // assigns no field name to it. Keep the grammar field authoritative when one is
  // present; otherwise the first identifier inside the declaration is its name.
  if (!field) return nodesOfType(decl, pack.nodes.identifier)[0]?.text
  if (field.childCount === 0) return field.text
  // C and C++ wrap the name in a declarator; look inside that, never wider
  return nodesOfType(field, pack.nodes.identifier)[0]?.text
}

/**
 * A language wrapper may sit between the syntax root and a reusable declaration.
 * Decorators and templates are part of the implementation fingerprint; namespaces
 * are part of the declaration identity. Type bodies and receiver/implementation
 * scopes are never traversed, so their methods remain deliberately non-reusable.
 */
export type ReusableDeclaration = {
  scope: string[]
  name: string
  node: Node
  tokens: Tok[]
}

export function reusableDeclarations(root: Node, pack: LanguagePack, bindingPath = ''): ReusableDeclaration[] {
  type Binding = {
    indexNames: string[]
    references: string[]
    scope: string[]
    node: Node
    tokens: Tok[]
    fingerprint: string
  }
  const raw: ReusableDeclaration[] = []
  const contexts: { scope: string[]; node: Node; tokens: Tok[] }[] = []
  const bindings: Binding[] = []

  const namesIn = (tokens: Tok[]): string[] => [
    ...new Set(tokens.filter((token) => pack.nodes.bindingIdentifier.includes(token.type)).map((token) => token.text)),
  ]
  const addBinding = (scope: string[], node: Node, tokens: Tok[], indexNames: string[]): void => {
    if (indexNames.length > 0) {
      bindings.push({
        node,
        tokens,
        scope,
        indexNames,
        references: namesIn(tokens),
        fingerprint: implementationFingerprint([
          { type: '__binding_scope__', text: JSON.stringify(scope) },
          ...tokens,
        ]),
      })
    }
  }

  const visit = (container: Node, scope: string[], fingerprintRoot?: Node): void => {
    let prefix: Node[] = []
    let blocked = false
    for (const child of container.namedChildren) {
      if (pack.nodes.comment.includes(child.type)) continue
      if (pack.nodes.reusablePrefix.includes(child.type)) {
        prefix.push(child)
        continue
      }
      if (pack.nodes.reusableBlocker.includes(child.type)) {
        blocked = true
        continue
      }
      if (pack.nodes.bindingContext.includes(child.type)) {
        contexts.push({ scope, node: child, tokens: tokensFor(child, pack) })
        prefix = []
        blocked = false
        continue
      }
      if (pack.nodes.reusableDeclaration.includes(child.type)) {
        if (blocked || (pack.reusableAcrossFiles && !pack.reusableAcrossFiles(child))) {
          prefix = []
          blocked = false
          continue
        }
        const name = declaredName(child, pack)
        if (!name) {
          if (pack.nodes.bindingDeclaration.includes(child.type)) {
            const bindingTokens = tokensFor(child, pack)
            addBinding(scope, child, bindingTokens, namesIn(bindingTokens))
          }
          prefix = []
          blocked = false
          continue
        }
        const ownTokens = [
          ...prefix.flatMap((node) => tokensFor(node, pack)),
          ...tokensFor(fingerprintRoot ?? child, pack),
        ]
        raw.push({
          scope,
          name,
          node: child,
          tokens: ownTokens,
        })
        addBinding(scope, child, ownTokens, [name])
        prefix = []
        blocked = false
        continue
      }
      if (pack.nodes.bindingDeclaration.includes(child.type)) {
        const bindingTokens = tokensFor(child, pack)
        addBinding(scope, child, bindingTokens, namesIn(bindingTokens))
        prefix = []
        blocked = false
        continue
      }
      if (!pack.nodes.reusableContainer.includes(child.type)) {
        prefix = []
        blocked = false
        continue
      }

      let nextScope = scope
      if (pack.nodes.reusableScope.includes(child.type)) {
        const name = child.childForFieldName('name')?.text
        // An anonymous namespace cannot provide a cross-file reuse candidate.
        if (!name) continue
        nextScope = [...scope, name]
      }
      visit(
        child,
        nextScope,
        fingerprintRoot ?? (pack.nodes.reusableWrapper.includes(child.type) ? child : undefined),
      )
      prefix = []
      blocked = false
    }
  }

  const fileScope = fileScopeIdentity(root, pack)
  visit(root, fileScope ? [fileScope] : [])

  const scopeKey = (scope: string[]): string => JSON.stringify(scope)
  const scopePrefixes = (scope: string[]): string[] =>
    Array.from({ length: scope.length + 1 }, (_, length) => scopeKey(scope.slice(0, length)))
  const byName = new Map<string, Map<string, Binding[]>>()
  for (const binding of bindings) {
    for (const name of binding.indexNames) {
      const byScope = byName.get(name) ?? new Map<string, Binding[]>()
      const scoped = byScope.get(scopeKey(binding.scope)) ?? []
      scoped.push(binding)
      byScope.set(scopeKey(binding.scope), scoped)
      byName.set(name, byScope)
    }
  }
  const needsBindingDirectory = (tokens: Tok[]): boolean => {
    const text = tokens.map((token) => token.text).join(' ')
    return /\brequire_relative\b|\b(?:require|include)(?:_once)?\b|\bfrom\s+\.+|["']\.\.?\/|#\s*include\s*"|\buse\s+(?:self|super)\s*::|\bmod\s+[A-Za-z_]\w*\s*;/.test(text)
  }
  const contextsByScope = new Map<string, typeof contexts>()
  for (const context of contexts) {
    const scoped = contextsByScope.get(scopeKey(context.scope)) ?? []
    scoped.push(context)
    contextsByScope.set(scopeKey(context.scope), scoped)
  }
  const contextCache = new Map<string, { tokens: Tok[]; needsDirectory: boolean }>()
  const contextFor = (scope: string[]): { tokens: Tok[]; needsDirectory: boolean } => {
    const key = scopeKey(scope)
    const known = contextCache.get(key)
    if (known) return known
    const visibleContexts = scopePrefixes(scope)
      .flatMap((prefix) => contextsByScope.get(prefix) ?? [])
      .sort((left, right) => left.node.startPosition.row - right.node.startPosition.row ||
        left.node.startPosition.column - right.node.startPosition.column)
    const ordered = visibleContexts.flatMap((context) => [
      { type: '__binding_scope__', text: JSON.stringify(context.scope) },
      ...context.tokens,
    ])
    const value = {
      tokens: ordered.length === 0
        ? []
        : [{ type: '__binding_context__', text: implementationFingerprint(ordered) }],
      needsDirectory: visibleContexts.some((context) => needsBindingDirectory(context.tokens)),
    }
    contextCache.set(key, value)
    return value
  }
  const identity = (node: Node): string => [
    node.type,
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  ].join(':')

  return raw.map((declaration) => {
    const context = contextFor(declaration.scope)
    const selected = new Map<string, Binding>()
    const pending = namesIn(declaration.tokens)
    const visitedNames = new Set<string>()
    const target = identity(declaration.node)
    while (pending.length > 0) {
      const name = pending.pop()!
      if (visitedNames.has(name)) continue
      visitedNames.add(name)
      const byScope = byName.get(name)
      for (const binding of scopePrefixes(declaration.scope).flatMap((prefix) => byScope?.get(prefix) ?? [])) {
        const key = identity(binding.node)
        if (key === target || selected.has(key)) continue
        selected.set(key, binding)
        // More than this is a generated binding graph, not a helper a human can
        // meaningfully reuse. Abstain instead of doing quadratic work on it.
        if (selected.size > 512) return []
        for (const referenced of binding.references) {
          if (!visitedNames.has(referenced)) pending.push(referenced)
        }
      }
    }
    const bindingTokens = [...selected.values()]
      .sort((left, right) => left.node.startPosition.row - right.node.startPosition.row ||
        left.node.startPosition.column - right.node.startPosition.column)
      .map((binding) => ({ type: '__binding__', text: binding.fingerprint }))
    const directoryToken = bindingPath !== '' && (
      context.needsDirectory ||
      needsBindingDirectory(declaration.tokens) ||
      [...selected.values()].some((binding) => needsBindingDirectory(binding.tokens))
    )
      ? [{ type: '__binding_directory__', text: posix.dirname(bindingPath.replaceAll('\\', '/')) }]
      : []
    return [{
      ...declaration,
      tokens: [...directoryToken, ...context.tokens, ...bindingTokens, ...declaration.tokens],
    }]
  }).flat()
}
