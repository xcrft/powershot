import type { Finding, ForeignFile } from '#app/types.js'
import { nodesOfType, walk, type LanguagePack, type Node } from '#app/lang/packs.js'

export type Tok = { type: string; text: string }

/**
 * In tree-sitter-rust and -go a `string_literal` has exactly two children, the quotes,
 * and the text between them belongs to no node — so walking to leaves loses it, and
 * two files differing only in what their strings say tokenize identically. Atomic.
 */
const ATOMIC = /string|char|raw_|heredoc|interpolat/

/** The token stream: what a compiler sees, minus layout and comments. */


export function tokensFor(root: Node, pack: LanguagePack): Tok[] {
  const out: Tok[] = []
  const visit = (n: Node): void => {
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
  if (!field) return undefined
  if (field.childCount === 0) return field.text
  // C and C++ wrap the name in a declarator; look inside that, never wider
  return nodesOfType(field, pack.nodes.identifier)[0]?.text
}

/** Module level only: two classes sharing a method name is polymorphism. */
export function topLevelDeclarations(root: Node, pack: LanguagePack): Map<string, Node> {
  const all = nodesOfType(root, pack.nodes.declaration)
  const out = new Map<string, Node>()
  for (const decl of all) {
    const nested = all.some(
      (other) =>
        other !== decl &&
        other.startPosition.row <= decl.startPosition.row &&
        other.endPosition.row >= decl.endPosition.row,
    )
    if (nested) continue
    const name = declaredName(decl, pack)
    if (name) out.set(name, decl)
  }
  return out
}
