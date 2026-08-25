import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

export type Node = {
  type: string
  text: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  childCount: number
  child(i: number): Node | null
  namedChildren: Node[]
  childForFieldName(name: string): Node | null
}

export type Tree = { rootNode: Node }

/**
 * The node names a generic check needs to do its job in this language. Most of a
 * pack is this table: the checks are the same idea everywhere, only the grammar's
 * vocabulary differs.
 */
export type NodeTable = {
  identifier: string[]
  comment: string[]
  /** conditionals whose branch can bail out */
  ifStatement: string[]
  /** grammar field names for the condition, branch, and optional alternative */
  ifCondition: string[]
  ifBody: string[]
  ifAlternative: string[]
  /** statements that leave the enclosing block */
  bail: string[]
  /** things that declare a named callable or type */
  declaration: string[]
  /** named callables whose control-flow can be compared across a change */
  callable: string[]
  /** outer body node removed before fingerprinting a callable's contract */
  callableBody: string[]
  /** lexical owners that are part of a callable's identity */
  callableOwner: string[]
  /** outer body node removed before fingerprinting an owner's identity */
  callableOwnerBody: string[]
  /** file-level package/module declarations that qualify every callable and reusable declaration */
  fileScope: string[]
  /** declarations safe for a language-agnostic cross-file reuse comparison */
  reusableDeclaration: string[]
  /** transparent syntax containers between the file root and a reusable declaration */
  reusableContainer: string[]
  /** transparent containers whose name is a language-level namespace */
  reusableScope: string[]
  /** transparent containers whose tokens change the wrapped declaration's meaning */
  reusableWrapper: string[]
  /** sibling syntax that semantically prefixes the next reusable declaration */
  reusablePrefix: string[]
  /** sibling parse nodes that make the next declaration unsafe to classify */
  reusableBlocker: string[]
  /** file or namespace directives that affect name binding for every declaration */
  bindingContext: string[]
  /** named module-level bindings pulled in when a declaration references them */
  bindingDeclaration: string[]
  /** identifier token types used only when tracing module-level bindings */
  bindingIdentifier: string[]
  /** grammar field holding a declaration's name */
  declarationName: string
  /** blocks whose children are sibling statements */
  block: string[]
}

export type LanguagePack = {
  name: string
  extensions: string[]
  /** grammar file inside tree-sitter-wasms */
  grammar: string
  nodes: NodeTable
  /** handlers that catch a failure and do nothing with it, in this language's idiom */
  swallowedError?(root: Node): { node: Node; what: string }[]
  /** how this language reads its environment */
  envReads?(root: Node): { name: string; node: Node }[]
  /** modules this file imports, where the language can be told from its stdlib */
  imports?(root: Node): { name: string; node: Node }[]
  /** callable signatures, for comparing what a change did to a contract */
  signatures?(root: Node): Map<string, { required: number; params: string[]; node: Node }>
  /** this language's test conventions, for the checks that judge whether tests prove anything */
  tests?(root: Node): TestFunction[]
  /** documented parameters against the real ones, per callable */
  documentedParams?(root: Node): { fn: string; declared: string[]; documented: { name: string; node: Node }[] }[]
  /** whether a declaration can actually be reused from another source file */
  reusableAcrossFiles?(node: Node): boolean
  /** non-code file constraints such as build tags or module-level cfg attributes */
  fileConstraints?(root: Node): string[]
}

export type TestFunction = {
  name: string
  node: Node
  /** every assertion in it, keyed by what it asserts about */
  assertions: { subject: string; expected: string; node: Node; expectedNode: Node }[]
  /** true when the body runs something but proves nothing */
  provesNothing: boolean
}

/** Shared defaults; a pack overrides only what its grammar spells differently. */
const COMMON_NODES = {
  identifier: ['identifier'],
  comment: ['comment', 'line_comment', 'block_comment'],
  ifCondition: ['condition'],
  ifBody: ['consequence', 'body'],
  ifAlternative: ['alternative'],
  declarationName: 'name',
  block: ['block'],
  callableBody: ['block'],
  callableOwner: [],
  callableOwnerBody: [],
  fileScope: [],
  reusableContainer: [],
  reusableScope: [],
  reusableWrapper: [],
  reusablePrefix: [],
  reusableBlocker: [],
  bindingContext: [],
  bindingDeclaration: [],
  bindingIdentifier: ['identifier'],
}

function declarationHeader(node: Node): string {
  const boundaries = [node.text.indexOf('{')]
  const end = boundaries.filter((index) => index >= 0).sort((left, right) => left - right)[0]
  return end === undefined ? node.text : node.text.slice(0, end)
}

/** Pull the key out of `getenv("HOME")` / `environ["HOME"]` style reads. */
function envKeysFrom(root: Node, callPattern: RegExp, callTypes: string[]): { name: string; node: Node }[] {
  const out: { name: string; node: Node }[] = []
  for (const call of nodesOfType(root, callTypes)) {
    if (!callPattern.test(call.text)) continue
    const key = /["'`]([A-Z_][A-Z0-9_]*)["'`]/.exec(call.text)
    if (key?.[1]) out.push({ name: key[1], node: call })
  }
  return out
}

/** depth-first walk, used by every pack */
export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) walk(child, visit)
  }
}

export function nodesOfType(root: Node, types: string[]): Node[] {
  const out: Node[] = []
  walk(root, (n) => {
    if (types.includes(n.type)) out.push(n)
  })
  return out
}

/**
 * A comment inside a handler is the author saying "I meant this", in every language.
 * Deliberate silence is not a defect, so it suppresses the finding — the same rule
 * the TypeScript checks already follow.
 */
function hasComment(node: Node | null): boolean {
  if (!node) return false
  let found = false
  walk(node, (n) => {
    if (n.type === 'comment' || n.type === 'line_comment' || n.type === 'block_comment') found = true
  })
  return found
}

/** A body is meaningless when it does nothing at all, or only says "pass". */
function isInertBlock(block: Node | null, inertTypes: string[]): boolean {
  if (!block) return false
  if (hasComment(block)) return false
  const statements = block.namedChildren.filter((c) => c.type !== 'comment')
  if (statements.length === 0) return true
  return statements.every((s) => inertTypes.includes(s.type))
}

/**
 * The try/catch family. Java, C++, C#, PHP, Kotlin, Swift and Scala all discard a
 * failure the same way — a handler whose body does nothing, or only logs — so the
 * rule is written once and each pack supplies its grammar's spelling.
 */
function catchBased(
  catchTypes: string[],
  bodyField: string | undefined,
  logPattern: RegExp,
): (root: Node) => { node: Node; what: string }[] {
  return (root) => {
    const out: { node: Node; what: string }[] = []
    for (const clause of nodesOfType(root, catchTypes)) {
      const body =
        (bodyField ? clause.childForFieldName(bodyField) : undefined) ??
        clause.namedChildren.find((c) => /block|compound_statement|statements/.test(c.type)) ??
        null

      // Kotlin and Swift put the braces straight on the catch clause, so an empty
      // handler has no body node at all to inspect — only a `{}` at the end
      if (!body) {
        if (/\{\s*\}\s*$/.test(clause.text) && !hasComment(clause)) {
          out.push({ node: clause, what: 'catch block does nothing' })
        }
        continue
      }

      if (isInertBlock(body, [])) {
        out.push({ node: clause, what: 'catch block does nothing' })
        continue
      }
      if (hasComment(body)) continue
      const statements = (body?.namedChildren ?? []).filter((c) => !COMMON_NODES.comment.includes(c.type))
      if (statements.length > 0 && statements.every((st) => logPattern.test(st.text.trim()))) {
        out.push({ node: clause, what: 'catch block only logs' })
      }
    }
    return out
  }
}

const PYTHON: LanguagePack = {
  name: 'python',
  extensions: ['.py', '.pyi'],
  grammar: 'tree-sitter-python',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    bail: ['return_statement', 'raise_statement', 'continue_statement', 'break_statement'],
    declaration: ['function_definition', 'class_definition'],
    callable: ['function_definition'],
    callableOwner: ['class_definition', 'decorated_definition'],
    callableOwnerBody: ['block', 'function_definition', 'class_definition'],
    reusableDeclaration: ['function_definition', 'class_definition'],
    reusableContainer: ['decorated_definition'],
    reusableWrapper: ['decorated_definition'],
    bindingContext: ['import_statement', 'import_from_statement'],
    bindingDeclaration: ['expression_statement'],
  },
  envReads(root) {
    return envKeysFrom(root, /os\.environ|getenv/, ['call', 'subscript'])
  },
  imports(root) {
    const out: { name: string; node: Node }[] = []
    for (const stmt of nodesOfType(root, ['import_statement', 'import_from_statement'])) {
      // `import a.b`, `from a.b import c`, `import a as x` — the module is the first
      // dotted name, and a relative `from . import x` has none
      const first = stmt.namedChildren.find((c) => c.type === 'dotted_name' || c.type === 'aliased_import')
      const dotted = first?.type === 'aliased_import' ? first.namedChildren[0] : first
      if (!dotted || stmt.text.includes('from .')) continue
      out.push({ name: dotted.text, node: stmt })
    }
    return out
  },
  signatures(root) {
    const out = new Map<string, { required: number; params: string[]; node: Node }>()
    for (const fn of nodesOfType(root, ['function_definition'])) {
      const name = fn.childForFieldName('name')
      const params = fn.childForFieldName('parameters')
      if (!name || !params) continue

      const listed: string[] = []
      let required = 0
      for (const p of params.namedChildren) {
        // *args and **kwargs demand nothing of a caller, and self/cls are bound
        if (p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') continue
        const label = p.text
        if (/^(self|cls)\b/.test(label)) continue
        listed.push(label)
        // a default makes it optional; a bare or annotated name does not
        if (p.type === 'identifier' || p.type === 'typed_parameter') required++
      }
      out.set(name.text, { required, params: listed, node: fn })
    }
    return out
  },
  tests(root) {
    const out: TestFunction[] = []
    for (const fn of nodesOfType(root, ['function_definition'])) {
      const name = fn.childForFieldName('name')?.text
      if (!name || !name.startsWith('test')) continue
      const body = fn.childForFieldName('body')
      if (!body) continue

      const assertions: TestFunction['assertions'] = []
      for (const stmt of nodesOfType(body, ['assert_statement'])) {
        // `assert subject == expected` is what can drift; a bare `assert x` cannot
        const comparison = stmt.namedChildren.find((c) => c.type === 'comparison_operator')
        const left = comparison?.namedChildren[0]
        const right = comparison?.namedChildren[1]
        if (comparison && left && right) {
          assertions.push({ subject: left.text, expected: right.text, node: stmt, expectedNode: right })
        }
      }
      // unittest style: self.assertEqual(subject, expected)
      for (const call of nodesOfType(body, ['call'])) {
        const fnName = call.childForFieldName('function')?.text ?? ''
        if (!/(^|\.)assert[A-Z_]/.test(fnName)) continue
        const args = call.childForFieldName('arguments')?.namedChildren ?? []
        if (args.length >= 2 && args[0] && args[1]) {
          assertions.push({ subject: args[0].text, expected: args[1].text, node: call, expectedNode: args[1] })
        }
      }

      // includes mock's family — `publish.assert_not_awaited()` is how most async
      // suites assert, and missing it called 25 good tests vacuous on a real repo
      const asserts =
        nodesOfType(body, ['assert_statement']).length > 0 ||
        nodesOfType(body, ['call']).some((c) =>
          /(^|\.)(assert[A-Z_a-z]|fail$|raises$)/.test(c.childForFieldName('function')?.text ?? ''),
        ) ||
        nodesOfType(body, ['with_statement']).some((w) => /raises|assertRaises|pytest\.warns/.test(w.text))
      const runsSomething = nodesOfType(body, ['call']).length > 0
      // a body that is only `pass` or a docstring is a placeholder, not a lie
      const isPlaceholder = body.namedChildren.every(
        (c) => c.type === 'pass_statement' || c.type === 'expression_statement' && /^["']/.test(c.text.trim()),
      )

      out.push({ name, node: fn, assertions, provesNothing: runsSomething && !asserts && !isPlaceholder })
    }
    return out
  },
  documentedParams(root) {
    const out: { fn: string; declared: string[]; documented: { name: string; node: Node }[] }[] = []
    for (const fn of nodesOfType(root, ['function_definition'])) {
      const name = fn.childForFieldName('name')?.text
      const params = fn.childForFieldName('parameters')
      const body = fn.childForFieldName('body')
      if (!name || !params || !body) continue

      // the docstring is the first statement, if it is a bare string
      const first = body.namedChildren[0]
      if (!first || first.type !== 'expression_statement' || !/^[ru]?["']/.test(first.text.trim())) continue

      const declared = params.namedChildren
        .filter((p) => p.type !== 'list_splat_pattern' && p.type !== 'dictionary_splat_pattern')
        .map((p) => (p.text.split(/[:=]/)[0] ?? '').trim())
        .filter((n) => n !== 'self' && n !== 'cls' && n !== '')

      const documented: { name: string; node: Node }[] = []
      const text = first.text
      // reST `:param name:`. A line at a time: across the whole string the optional
      // type group swallows the name and matches the *next* directive's colon.
      for (const line of text.split('\n')) {
        const m = /^\s*:param\s+(?:[^\s:]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line)
        if (m?.[1]) documented.push({ name: m[1], node: first })
      }
      // Google: an `Args:` block, one `name:` or `name (type):` per line
      const args = /\n\s*Args:\s*\n([\s\S]*?)(\n\s*(?:Returns|Raises|Yields|Examples?|Notes?):|["']{3})/.exec(text)
      if (args?.[1]) {
        for (const line of args[1].split('\n')) {
          const m = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:/.exec(line)
          if (m?.[1]) documented.push({ name: m[1], node: first })
        }
      }
      if (documented.length > 0) out.push({ fn: name, declared, documented })
    }
    return out
  },
  swallowedError(root) {
    const out: { node: Node; what: string }[] = []
    for (const clause of nodesOfType(root, ['except_clause'])) {
      const block = clause.namedChildren.find((c) => c.type === 'block') ?? null
      // `except: pass` is the canonical Python spelling of discarding a failure
      if (isInertBlock(block, ['pass_statement', 'ellipsis'])) {
        out.push({ node: clause, what: 'except block does nothing' })
        continue
      }
      if (hasComment(block)) continue
      const statements = (block?.namedChildren ?? []).filter((c) => c.type !== 'comment')
      const onlyLogs =
        statements.length > 0 &&
        statements.every(
          (s) =>
            s.type === 'expression_statement' &&
            /^(print|log|logger|logging)\s*[.(]/.test(s.text.trim()),
        )
      if (onlyLogs) out.push({ node: clause, what: 'except block only logs' })
    }
    return out
  },
  fileConstraints(root) {
    return root.namedChildren
      .filter((node) => COMMON_NODES.comment.includes(node.type) && node.startPosition.row <= 1)
      .map((node) => node.text.trim())
      .filter((text) => /coding\s*[:=]/.test(text))
  },
}

const GO: LanguagePack = {
  name: 'go',
  extensions: ['.go'],
  grammar: 'tree-sitter-go',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    bail: ['return_statement', 'continue_statement', 'break_statement', 'goto_statement'],
    declaration: ['function_declaration', 'method_declaration', 'type_declaration'],
    callable: ['function_declaration', 'method_declaration'],
    fileScope: ['package_clause'],
    reusableDeclaration: ['function_declaration', 'type_declaration'],
    bindingContext: ['import_declaration'],
    bindingDeclaration: ['const_declaration', 'var_declaration', 'type_declaration'],
    bindingIdentifier: ['identifier', 'type_identifier'],
  },
  envReads(root) {
    return envKeysFrom(root, /os\.Getenv|os\.LookupEnv/, ['call_expression'])
  },
  swallowedError(root) {
    const out: { node: Node; what: string }[] = []

    // Go has no catch: the idiom is `if err != nil { ... }`, and the failure is
    // discarded when that body does nothing
    for (const stmt of nodesOfType(root, ['if_statement'])) {
      const cond = stmt.childForFieldName('condition')
      if (!cond || !/\berr\b\s*!=\s*nil/.test(cond.text)) continue
      const body = stmt.childForFieldName('consequence')
      if (isInertBlock(body, [])) out.push({ node: stmt, what: 'error is checked and then ignored' })
    }

    // `_ = f()` deliberately NOT reported: Go compiles without assigning at all, so
    // the blank identifier is someone saying "I know". An empty `if err != nil` isn't.
    return out
  },
  fileConstraints(root) {
    return root.namedChildren
      .filter((node) => COMMON_NODES.comment.includes(node.type))
      .map((node) => node.text.trim())
      .filter((text) => /^\/\/go:build\b|^\/\/\s*\+build\b/.test(text))
  },
}

const JAVA: LanguagePack = {
  name: 'java',
  extensions: ['.java'],
  grammar: 'tree-sitter-java',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    bail: ['return_statement', 'throw_statement', 'continue_statement', 'break_statement'],
    declaration: ['method_declaration', 'class_declaration', 'interface_declaration', 'record_declaration'],
    callable: ['method_declaration', 'constructor_declaration'],
    fileScope: ['package_declaration'],
    callableBody: ['block', 'constructor_body'],
    callableOwner: [
      'class_declaration', 'interface_declaration', 'record_declaration',
      'enum_declaration', 'annotation_type_declaration',
    ],
    callableOwnerBody: ['class_body', 'interface_body', 'record_body', 'enum_body', 'annotation_type_body'],
    reusableDeclaration: ['class_declaration', 'interface_declaration', 'record_declaration'],
    bindingContext: ['import_declaration'],
    block: ['block', 'constructor_body'],
  },
  envReads(root) {
    return envKeysFrom(root, /System\.getenv/, ['method_invocation'])
  },
  swallowedError: catchBased(['catch_clause'], 'body', /^(System\.(out|err)|log|logger|LOG|LOGGER)\s*\./),
}

const RUST: LanguagePack = {
  name: 'rust',
  extensions: ['.rs'],
  grammar: 'tree-sitter-rust',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_expression'],
    bail: ['return_expression', 'break_expression', 'continue_expression'],
    declaration: ['function_item', 'struct_item', 'enum_item', 'trait_item'],
    callable: ['function_item'],
    callableOwner: ['impl_item', 'trait_item', 'mod_item'],
    callableOwnerBody: ['declaration_list'],
    reusableDeclaration: ['function_item', 'struct_item', 'enum_item', 'trait_item'],
    reusablePrefix: ['attribute_item'],
    bindingContext: ['use_declaration', 'extern_crate_declaration'],
    bindingDeclaration: ['const_item', 'static_item', 'type_item', 'mod_item'],
    bindingIdentifier: ['identifier', 'type_identifier'],
  },
  envReads(root) {
    return envKeysFrom(root, /env::var|env::var_os/, ['call_expression'])
  },
  swallowedError(root) {
    const out: { node: Node; what: string }[] = []

    // `let _ = fallible()` deliberately NOT reported: it is Rust's own "on purpose",
    // written to silence #[must_use]. Measured, 59 findings over 19 commits, all
    // idiomatic. An empty `Err(..)` arm has no such marker.
    for (const arm of nodesOfType(root, ['match_arm'])) {
      const pattern = arm.childForFieldName('pattern')
      if (!pattern || !/^Err\b/.test(pattern.text.trim())) continue
      const value = arm.childForFieldName('value')
      if (value && (value.text.trim() === '{}' || isInertBlock(value, []))) {
        out.push({ node: arm, what: 'Err arm does nothing' })
      }
    }
    return out
  },
  reusableAcrossFiles(node) {
    // `pub(self)`, `pub(super)`, and `pub(in ...)` need a module graph to prove
    // accessibility from another file. Plain `pub` and crate-wide visibility do not.
    return /\bpub(?:\s*\(\s*crate\s*\))?\s+/.test(declarationHeader(node))
  },
  fileConstraints(root) {
    return nodesOfType(root, ['inner_attribute_item']).map((node) => node.text.trim())
  },
}

const CLIKE_LOG = /^(std::(cout|cerr)|printf|fprintf|Console\.|Log|log|logger|error_log|print_r|var_dump)/

const CPP: LanguagePack = {
  name: 'cpp',
  extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'],
  grammar: 'tree-sitter-cpp',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    bail: ['return_statement', 'throw_statement', 'break_statement', 'continue_statement', 'goto_statement'],
    declaration: ['function_definition'],
    callable: ['function_definition'],
    callableBody: ['compound_statement'],
    callableOwner: [
      'namespace_definition', 'class_specifier', 'struct_specifier', 'union_specifier', 'template_declaration',
    ],
    callableOwnerBody: ['declaration_list', 'field_declaration_list', 'function_definition'],
    reusableDeclaration: ['function_definition'],
    reusableContainer: ['namespace_definition', 'declaration_list', 'template_declaration'],
    reusableScope: ['namespace_definition'],
    reusableWrapper: ['template_declaration'],
    bindingContext: [
      'preproc_include', 'preproc_def', 'preproc_function_def',
      'using_declaration', 'alias_declaration', 'namespace_alias_definition',
    ],
    bindingDeclaration: ['declaration', 'type_definition'],
    bindingIdentifier: ['identifier', 'type_identifier', 'namespace_identifier'],
    declarationName: 'declarator',
    block: ['compound_statement'],
  },
  envReads: (root) => envKeysFrom(root, /getenv|GetEnvironmentVariable/, ['call_expression']),
  swallowedError: catchBased(['catch_clause'], 'body', CLIKE_LOG),
  reusableAcrossFiles(node) {
    return !/\bstatic\b/.test(declarationHeader(node))
  },
}

const C: LanguagePack = {
  name: 'c',
  extensions: ['.c'],
  grammar: 'tree-sitter-c',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    bail: ['return_statement', 'break_statement', 'continue_statement', 'goto_statement'],
    declaration: ['function_definition'],
    callable: ['function_definition'],
    callableBody: ['compound_statement'],
    reusableDeclaration: ['function_definition'],
    bindingContext: ['preproc_include', 'preproc_def', 'preproc_function_def'],
    bindingDeclaration: ['declaration', 'type_definition'],
    bindingIdentifier: ['identifier', 'type_identifier'],
    declarationName: 'declarator',
    block: ['compound_statement'],
  },
  envReads: (root) => envKeysFrom(root, /getenv/, ['call_expression']),
  reusableAcrossFiles(node) {
    return !/\bstatic\b/.test(declarationHeader(node))
  },
  // C has no exceptions; its error handling is return codes, which cannot be told
  // from ordinary control flow without types. The other checks still apply.
}

const CSHARP: LanguagePack = {
  name: 'c#',
  extensions: ['.cs'],
  grammar: 'tree-sitter-c_sharp',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    bail: ['return_statement', 'throw_statement', 'break_statement', 'continue_statement'],
    declaration: ['method_declaration', 'class_declaration', 'interface_declaration', 'record_declaration'],
    callable: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
    callableOwner: [
      'namespace_declaration', 'file_scoped_namespace_declaration',
      'class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration',
    ],
    callableOwnerBody: ['declaration_list'],
    reusableDeclaration: ['class_declaration', 'interface_declaration', 'record_declaration'],
    reusableContainer: ['namespace_declaration', 'file_scoped_namespace_declaration', 'declaration_list'],
    reusableScope: ['namespace_declaration', 'file_scoped_namespace_declaration'],
    reusableBlocker: ['ERROR'],
    bindingContext: ['using_directive', 'extern_alias_directive'],
    block: ['block', 'declaration_list'],
  },
  envReads: (root) => envKeysFrom(root, /GetEnvironmentVariable/, ['invocation_expression']),
  swallowedError: catchBased(['catch_clause'], 'body', CLIKE_LOG),
}

const PHP: LanguagePack = {
  name: 'php',
  extensions: ['.php'],
  grammar: 'tree-sitter-php',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    bail: ['return_statement', 'throw_expression', 'break_statement', 'continue_statement'],
    declaration: ['function_definition', 'method_declaration', 'class_declaration'],
    callable: ['function_definition', 'method_declaration'],
    callableBody: ['compound_statement'],
    callableOwner: [
      'namespace_definition', 'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration',
    ],
    callableOwnerBody: ['compound_statement', 'declaration_list'],
    reusableDeclaration: ['function_definition', 'class_declaration'],
    reusableContainer: ['namespace_definition', 'compound_statement'],
    reusableScope: ['namespace_definition'],
    bindingContext: ['namespace_use_declaration', 'expression_statement'],
    bindingDeclaration: ['const_declaration'],
    bindingIdentifier: ['name', 'variable_name'],
    block: ['compound_statement'],
  },
  envReads: (root) => envKeysFrom(root, /getenv|\$_ENV/, ['function_call_expression', 'subscript_expression']),
  swallowedError: catchBased(['catch_clause'], 'body', CLIKE_LOG),
}

const KOTLIN: LanguagePack = {
  name: 'kotlin',
  extensions: ['.kt', '.kts'],
  grammar: 'tree-sitter-kotlin',
  nodes: {
    ...COMMON_NODES,
    identifier: ['simple_identifier'],
    ifStatement: ['if_expression'],
    bail: ['jump_expression'],
    declaration: ['function_declaration', 'class_declaration', 'object_declaration'],
    callable: ['function_declaration'],
    fileScope: ['package_header'],
    callableBody: ['function_body', 'block', 'statements'],
    callableOwner: ['class_declaration', 'object_declaration'],
    callableOwnerBody: ['class_body'],
    reusableDeclaration: ['function_declaration', 'class_declaration', 'object_declaration'],
    reusableContainer: ['import_list'],
    bindingContext: ['import_header'],
    bindingDeclaration: ['property_declaration', 'type_alias'],
    bindingIdentifier: ['simple_identifier', 'type_identifier'],
    block: ['statements', 'block'],
  },
  envReads: (root) => envKeysFrom(root, /System\.getenv|getenv/, ['call_expression']),
  swallowedError: catchBased(['catch_block'], undefined, /^(println|print|log|logger|Log)\b/),
  reusableAcrossFiles(node) {
    return !/\bprivate\b/.test(declarationHeader(node))
  },
}

/*
 * Swift is deliberately absent.
 *
 * The pack was written and all of its checks passed — and then the process died
 * every time, inside V8's background compilation of that grammar, with a signal no
 * `try` can catch. It is not a bug in the rule: the grammar reliably takes the
 * runtime down after the work is done.
 *
 * The rule this project holds to is that an unsupported language goes unreviewed and
 * never crashes the run, so shipping a pack that kills the process would break the
 * guarantee it exists to serve. Restore it when the grammar or the runtime changes;
 * the definition is kept here so nobody rewrites it from scratch.
 */
const SWIFT_DISABLED: LanguagePack = {
  name: 'swift',
  extensions: ['.swift'],
  grammar: 'tree-sitter-swift',
  nodes: {
    ...COMMON_NODES,
    identifier: ['simple_identifier'],
    ifStatement: ['if_statement'],
    bail: ['control_transfer_statement'],
    declaration: ['function_declaration', 'class_declaration', 'protocol_declaration'],
    callable: ['function_declaration'],
    callableBody: ['function_body', 'statements'],
    callableOwner: [
      'class_declaration', 'struct_declaration', 'protocol_declaration',
      'extension_declaration', 'enum_declaration',
    ],
    callableOwnerBody: ['class_body', 'protocol_body', 'enum_class_body'],
    reusableDeclaration: ['function_declaration', 'class_declaration', 'protocol_declaration'],
    block: ['statements', 'function_body'],
  },
  envReads: (root) => envKeysFrom(root, /ProcessInfo|environment/, ['call_expression', 'subscript_expression']),
  swallowedError: catchBased(['catch_block'], undefined, /^(print|NSLog|os_log|logger)\b/),
}

const RUBY: LanguagePack = {
  name: 'ruby',
  extensions: ['.rb', '.rake'],
  grammar: 'tree-sitter-ruby',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if', 'if_modifier', 'unless', 'unless_modifier'],
    bail: ['return', 'break', 'next'],
    declaration: ['method', 'singleton_method', 'class', 'module'],
    callable: ['method', 'singleton_method'],
    callableBody: ['body_statement'],
    callableOwner: ['class', 'module'],
    callableOwnerBody: ['body_statement'],
    reusableDeclaration: ['method', 'singleton_method', 'class', 'module'],
    bindingContext: ['call'],
    bindingDeclaration: ['assignment'],
    bindingIdentifier: ['identifier', 'constant'],
    block: ['body_statement', 'do_block', 'block'],
  },
  envReads: (root) => envKeysFrom(root, /ENV/, ['element_reference', 'call']),
  imports(root) {
    const out: { name: string; node: Node }[] = []
    for (const call of nodesOfType(root, ['call'])) {
      const method = call.childForFieldName('method')?.text
      // require_relative always names this repository's own files
      if (method !== 'require') continue
      const literal = /["']([^"']+)["']/.exec(call.text)
      if (literal?.[1]) out.push({ name: literal[1], node: call })
    }
    return out
  },
  swallowedError(root) {
    const out: { node: Node; what: string }[] = []
    for (const rescue of nodesOfType(root, ['rescue'])) {
      // a rescue holds its handler inline, so an empty one has no body_statement
      if (hasComment(rescue)) continue
      const body = rescue.namedChildren.find((c) => c.type === 'body_statement' || c.type === 'then')
      const statements = (body?.namedChildren ?? []).filter((c) => !COMMON_NODES.comment.includes(c.type))
      if (statements.length === 0) {
        out.push({ node: rescue, what: 'rescue block does nothing' })
        continue
      }
      if (statements.every((st) => /^(puts|print|p|log|logger|Rails\.logger)\b/.test(st.text.trim()))) {
        out.push({ node: rescue, what: 'rescue block only logs' })
      }
    }
    return out
  },
  fileConstraints(root) {
    return root.namedChildren
      .filter((node) => COMMON_NODES.comment.includes(node.type) && node.startPosition.row <= 1)
      .map((node) => node.text.trim())
      .filter((text) => /^#\s*(?:frozen_string_literal|encoding|coding)\s*[:=]/.test(text))
  },
}

void SWIFT_DISABLED

const SOLIDITY: LanguagePack = {
  name: 'solidity',
  extensions: ['.sol'],
  grammar: 'tree-sitter-solidity',
  nodes: {
    ...COMMON_NODES,
    ifStatement: ['if_statement'],
    // revert and require are how a contract refuses, alongside plain return
    bail: ['return_statement', 'revert_statement', 'break_statement', 'continue_statement'],
    declaration: ['function_definition', 'contract_declaration', 'modifier_definition'],
    callable: ['function_definition', 'modifier_definition'],
    callableBody: ['function_body', 'block_statement'],
    callableOwner: ['contract_declaration'],
    callableOwnerBody: ['contract_body'],
    reusableDeclaration: ['function_definition', 'contract_declaration'],
    bindingContext: ['import_directive', 'pragma_directive'],
    bindingDeclaration: [
      'constant_variable_declaration', 'struct_declaration', 'enum_declaration',
      'user_defined_value_type_definition',
    ],
    block: ['block_statement', 'function_body', 'contract_body'],
  },
  swallowedError: catchBased(['catch_clause'], 'body', /^(emit|console\.log)/),
}

export const PACKS: LanguagePack[] = [PYTHON, GO, JAVA, RUST, CPP, C, CSHARP, PHP, KOTLIN, RUBY, SOLIDITY]

export function packFor(path: string): LanguagePack | undefined {
  return PACKS.find((p) => p.extensions.some((e) => path.endsWith(e)))
}

type ParserCtor = { init(): Promise<void>; new (): { setLanguage(l: unknown): void; parse(s: string): Tree }; Language: { load(p: string): Promise<unknown> } }

let ready: Promise<ParserCtor> | undefined
const parsers = new Map<string, { parse(s: string): Tree }>()

/**
 * Grammars load lazily and once. A repository with no Python pays nothing for
 * Python, and the wasm runtime is only initialised when a foreign file appears.
 */
async function parserFor(pack: LanguagePack): Promise<{ parse(s: string): Tree } | undefined> {
  const cached = parsers.get(pack.name)
  if (cached) return cached

  try {
    if (!ready) {
      ready = (async () => {
        const mod = (await import('web-tree-sitter')) as unknown as { default?: ParserCtor }
        const Parser = (mod.default ?? mod) as ParserCtor
        await Parser.init()
        return Parser
      })()
    }
    const Parser = await ready
    const require_ = createRequire(import.meta.url)
    const wasmDir = join(dirname(require_.resolve('tree-sitter-wasms/package.json')), 'out')
    const language = await Parser.Language.load(join(wasmDir, pack.grammar + '.wasm'))
    const parser = new Parser()
    parser.setLanguage(language)
    parsers.set(pack.name, parser)
    return parser
  } catch {
    // a missing grammar means this language is simply not reviewed — never a crash
    return undefined
  }
}

export async function parse(pack: LanguagePack, source: string): Promise<Tree | undefined> {
  const parser = await parserFor(pack)
  if (!parser) return undefined
  try {
    return parser.parse(source)
  } catch {
    return undefined
  }
}

type NativeNode = Node & {
  startIndex: number
  endIndex: number
  isNamed: boolean
  fieldNameForChild(index: number): string | null
}

export type SerializedNode = {
  type: string
  startIndex: number
  endIndex: number
  startPosition: Node['startPosition']
  endPosition: Node['endPosition']
  named: boolean
  field?: string
  children: SerializedNode[]
}

export type SerializedTree = { root: SerializedNode }

/** Turn a native WASM-backed tree into data that can cross a worker boundary. */
export function serializeTree(tree: Tree): SerializedTree {
  const copy = (raw: Node, field?: string): SerializedNode => {
    const node = raw as NativeNode
    const children: SerializedNode[] = []
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) children.push(copy(child, node.fieldNameForChild(i) ?? undefined))
    }
    return {
      type: node.type,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      startPosition: { ...node.startPosition },
      endPosition: { ...node.endPosition },
      named: node.isNamed,
      field,
      children,
    }
  }
  return { root: copy(tree.rootNode) }
}

/** Restore the small Node interface the language-independent verifiers consume. */
function hydrateTree(source: string, tree: SerializedTree): Tree {
  const hydrate = (data: SerializedNode): Node => {
    const children = data.children.map(hydrate)
    return {
      type: data.type,
      get text() { return source.slice(data.startIndex, data.endIndex) },
      startPosition: { ...data.startPosition },
      endPosition: { ...data.endPosition },
      childCount: children.length,
      child: (index) => children[index] ?? null,
      namedChildren: children.filter((_, index) => data.children[index]?.named),
      childForFieldName: (name) => {
        const index = data.children.findIndex((child) => child.field === name)
        return index < 0 ? null : (children[index] ?? null)
      },
    }
  }
  return { rootNode: hydrate(tree.root) }
}

/**
 * Parse one language in a disposable worker.
 *
 * V8 keeps compiled WASM grammars alive longer than their JS parsers. Eleven
 * grammars in one process reached ~690MB and killed real mixed-language runs.
 * One worker owns one grammar, returns plain trees, and is then terminated, so
 * compiled-grammar memory is bounded by one language rather than by the monorepo's
 * language count. Plain trees still scale with the selected diff.
 */
export function parseIsolated(
  pack: LanguagePack,
  sources: string[],
  signal?: AbortSignal,
): Promise<(Tree | undefined)[]> {
  if (sources.length === 0) return Promise.resolve([])
  if (signal?.aborted) return Promise.resolve(sources.map(() => undefined))

  return new Promise((resolve) => {
    let worker: Worker
    let settled = false
    const empty = (): undefined[] => sources.map(() => undefined)
    const finish = (trees: (Tree | undefined)[]): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      // Resolve only after V8 has released this worker's WASM grammar. Otherwise a
      // fast next batch can overlap termination and recreate the memory spike this
      // isolation boundary exists to prevent.
      void worker.terminate().then(
        () => resolve(trees),
        () => resolve(trees),
      )
    }
    const abort = (): void => finish(empty())

    try {
      worker = new Worker(new URL('./parse-worker.js', import.meta.url), {
        workerData: { language: pack.name, sources },
      })
    } catch {
      resolve(empty())
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('message', (raw: (SerializedTree | undefined)[]) => {
      if (!Array.isArray(raw) || raw.length !== sources.length) {
        finish(empty())
        return
      }
      finish(raw.map((tree, index) => tree ? hydrateTree(sources[index]!, tree) : undefined))
    })
    worker.once('error', () => finish(empty()))
    worker.once('exit', () => finish(empty()))
    // Close the narrow race between the early check and listener registration.
    if (signal?.aborted) abort()
  })
}
