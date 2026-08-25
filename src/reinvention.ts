import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  Node,
  ts,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type SourceFile,
} from 'ts-morph'
import { insideRepo, repoPath } from './fspolicy.js'

type Callable = FunctionDeclaration | ArrowFunction | FunctionExpression

export type ExportedDeclaration = { name: string; node: Node }

/**
 * Compiler-resolved exports plus direct syntax exports.
 *
 * ts-morph's export map can be empty for JavaScript source even when the parser sees
 * an `export` modifier. The syntax fallback keeps JS at the same evidence level as
 * TypeScript without treating an unexported helper as reusable across files.
 */
export function exportedDeclarations(source: SourceFile): ExportedDeclaration[] {
  const out: ExportedDeclaration[] = []
  const seen = new Set<string>()
  const add = (name: string | undefined, node: Node | undefined): void => {
    if (!name || !node) return
    const key = [
      name,
      node.getSourceFile().getFilePath(),
      node.getKind(),
      node.getStart(),
      node.getEnd(),
    ].join('\u0000')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name, node })
  }

  for (const [name, declarations] of source.getExportedDeclarations()) {
    for (const declaration of declarations) add(name, declaration)
  }
  const locals = new Map<string, Node[]>()
  const addLocal = (name: string | undefined, node: Node): void => {
    if (!name) return
    const declarations = locals.get(name) ?? []
    declarations.push(node)
    locals.set(name, declarations)
  }
  for (const declaration of source.getFunctions()) addLocal(declaration.getName(), declaration)
  for (const declaration of source.getVariableDeclarations()) addLocal(declaration.getName(), declaration)
  for (const declaration of source.getClasses()) addLocal(declaration.getName(), declaration)
  for (const declaration of source.getExportDeclarations()) {
    if (declaration.getModuleSpecifier()) continue
    for (const specifier of declaration.getNamedExports()) {
      const exportedName = specifier.getAliasNode()?.getText() ?? specifier.getName()
      for (const local of locals.get(specifier.getName()) ?? []) add(exportedName, local)
    }
  }
  for (const declaration of source.getFunctions()) {
    if (declaration.hasExportKeyword()) add(declaration.getName(), declaration)
  }
  for (const declaration of source.getVariableDeclarations()) {
    if (declaration.getVariableStatement()?.hasExportKeyword()) add(declaration.getName(), declaration)
  }
  return out
}

const SCOPE_FILES = [
  'package.json',
  'pyproject.toml', 'setup.py', 'setup.cfg',
  'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'composer.json', 'Gemfile',
  'CMakeLists.txt', 'meson.build',
  'foundry.toml',
]
const SCOPE_SUFFIX = /\.(?:csproj|sln|gemspec)$/i

function declaresScope(dir: string): boolean {
  if (SCOPE_FILES.some((name) => existsSync(resolve(dir, name)))) return true
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && SCOPE_SUFFIX.test(entry.name))
  } catch {
    return false
  }
}

/**
 * Resolve package boundaries once per directory. A symbol index can contain tens of
 * thousands of declarations in a monorepo, so walking and reading every ancestor for
 * every symbol would turn a conservative check into the slowest part of the review.
 */
export function createReinventionScopeResolver(root: string): (file: string) => string {
  root = resolve(root)
  const cache = new Map<string, string>()
  const scopeForDirectory = (dir: string): string => {
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    let scope: string
    if (declaresScope(dir)) scope = repoPath(root, dir)
    else if (dir === root) scope = ''
    else {
      const parent = dirname(dir)
      scope = parent === dir || !insideRepo(root, parent) ? '' : scopeForDirectory(parent)
    }
    cache.set(dir, scope)
    return scope
  }
  return (file: string): string => {
    const abs = insideRepo(root, file)
    return abs ? scopeForDirectory(dirname(abs)) : ''
  }
}

/** Nearest language-appropriate package boundary, or the repository root. */
export function reinventionScope(root: string, file: string): string {
  return createReinventionScopeResolver(root)(file)
}

function callable(node: Node): Callable | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node
  if (!Node.isVariableDeclaration(node)) return undefined
  const init = node.getInitializer()
  return init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) ? init : undefined
}

function identifierTexts(source: string): Set<string> {
  const identifiers = new Set<string>()
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source)
  let token = scanner.scan()
  for (let count = 0; token !== ts.SyntaxKind.EndOfFileToken && count < 100_000; count++) {
    if (token === ts.SyntaxKind.Identifier) identifiers.add(scanner.getTokenText())
    token = scanner.scan()
  }
  return identifiers
}

/** Comments whose contents change TypeScript/JavaScript binding or compilation. */
function semanticDirectives(source: string): string[] {
  const directives: string[] = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const text = line.trim()
    if (
      text.startsWith('#!') ||
      /^\/\/\/\s*<reference\b/.test(text) ||
      /^\/\/\s*@(ts-check|ts-nocheck|jsx\w*)\b/.test(text)
    ) directives.push(String(index + 1) + ':' + text)
  }
  return directives
}

function contains(container: Node, target: Node): boolean {
  return container.getSourceFile() === target.getSourceFile() &&
    container.getStart() <= target.getStart() &&
    container.getEnd() >= target.getEnd()
}

type Binding = { names: string[]; node: Node }
type BindingIndex = { imports: Node[]; byName: Map<string, Binding[]> }

const BINDING_INDEX = new WeakMap<SourceFile, BindingIndex>()
const IDENTIFIERS = new WeakMap<Node, ReadonlySet<string>>()
const BINDING_CONTEXT = new WeakMap<Node, Map<string, string>>()
const TYPESCRIPT_FINGERPRINT = new WeakMap<Node, Map<string, string | null>>()

function identifiersOf(node: Node): ReadonlySet<string> {
  const known = IDENTIFIERS.get(node)
  if (known) return known
  const identifiers = identifierTexts(node.getText())
  IDENTIFIERS.set(node, identifiers)
  return identifiers
}

/** Build the file's binding index once, however many exported aliases inspect it. */
function bindingIndex(source: SourceFile): BindingIndex {
  const known = BINDING_INDEX.get(source)
  if (known) return known

  const imports: Node[] = []
  const byName = new Map<string, Binding[]>()
  const add = (names: string[], node: Node): void => {
    const binding = { names, node }
    for (const name of names) {
      const bindings = byName.get(name) ?? []
      bindings.push(binding)
      byName.set(name, bindings)
    }
  }
  const named = (name: string | undefined, node: Node): void => {
    if (name) add([name], node)
  }

  for (const statement of source.getStatements()) {
    if (Node.isImportDeclaration(statement) || Node.isImportEqualsDeclaration(statement)) {
      imports.push(statement)
    } else if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement) ||
      Node.isModuleDeclaration(statement)
    ) {
      named(statement.getName(), statement)
    } else if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode()
        const names = Node.isIdentifier(nameNode)
          ? [nameNode.getText()]
          : nameNode.getDescendantsOfKind(ts.SyntaxKind.Identifier).map((identifier) => identifier.getText())
        add(names, declaration)
      }
    }
  }

  const index = { imports, byName }
  BINDING_INDEX.set(source, index)
  return index
}

function normalizedDirectory(path: string): string {
  return dirname(path.replaceAll('\\', '/'))
}

function hasRelativeModuleReference(nodes: Iterable<Node>): boolean {
  for (const node of nodes) {
    if (
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']\.\.?\//.test(node.getText()) ||
      (Node.isImportDeclaration(node) && node.getModuleSpecifierValue().startsWith('.'))
    ) return true
  }
  return false
}

/** Imports plus only the transitive top-level bindings named by a callable. */
function bindingContext(target: Node, bindingPath: string): string {
  const cache = BINDING_CONTEXT.get(target) ?? new Map<string, string>()
  BINDING_CONTEXT.set(target, cache)
  const known = cache.get(bindingPath)
  if (known !== undefined) return known

  const index = bindingIndex(target.getSourceFile())
  const selected = new Set<Node>(index.imports)
  const pending = [...identifiersOf(target)]
  const visitedNames = new Set<string>()

  while (pending.length > 0) {
    const name = pending.pop()!
    if (visitedNames.has(name)) continue
    visitedNames.add(name)
    for (const binding of index.byName.get(name) ?? []) {
      if (selected.has(binding.node) || contains(binding.node, target)) continue
      selected.add(binding.node)
      for (const identifier of identifiersOf(binding.node)) {
        if (!visitedNames.has(identifier)) pending.push(identifier)
      }
    }
  }

  const ordered = [...selected]
    .sort((left, right) => left.getStart() - right.getStart())
  const bindingDirectory = hasRelativeModuleReference([...ordered, target])
    ? 'const __powershot_binding_directory__ = ' + JSON.stringify(normalizedDirectory(bindingPath))
    : ''
  const directives = semanticDirectives(target.getSourceFile().getFullText())
    .map((directive) => 'const __powershot_directive__ = ' + JSON.stringify(directive))
  const context = [bindingDirectory, ...directives, ...ordered.map((node) => node.getText())].join('\n')
  cache.set(bindingPath, context)
  return context
}

/**
 * Exact program tokens for a callable, excluding its export modifier and declared
 * name. Layout and comments may differ; parameters, types, operators, callees and
 * literals may not. That is deliberately conservative: a name match proposes a
 * candidate, but only equivalent executable text is deterministic evidence that a
 * helper was reimplemented.
 */
export function typescriptImplementationFingerprint(
  node: Node,
  bindingPath: string = node.getSourceFile().getFilePath(),
): string | undefined {
  const cache = TYPESCRIPT_FINGERPRINT.get(node) ?? new Map<string, string | null>()
  TYPESCRIPT_FINGERPRINT.set(node, cache)
  const known = cache.get(bindingPath)
  if (known !== undefined) return known ?? undefined

  const fn = callable(node)
  const body = fn?.getBody()
  if (!fn || !body) {
    cache.set(bindingPath, null)
    return undefined
  }

  const generator = !Node.isArrowFunction(fn) && fn.isGenerator()
  const source = [
    bindingContext(node, bindingPath),
    fn.isAsync() ? 'async' : 'sync',
    generator ? 'generator' : 'plain',
    '<' + fn.getTypeParameters().map((parameter) => parameter.getText()).join(',') + '>',
    '(' + fn.getParameters().map((parameter) => parameter.getText()).join(',') + ')',
    ':' + (fn.getReturnTypeNode()?.getText() ?? ''),
    body.getText(),
  ].join('\n')

  const fingerprint = typescriptTokenFingerprint(source)
  cache.set(bindingPath, fingerprint ?? null)
  return fingerprint
}

/** Exact TypeScript/JavaScript program tokens, excluding layout and comments. */
export function typescriptTokenFingerprint(source: string): string | undefined {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source)
  const tokens: { type: string | number; text: string }[] = []
  let token = scanner.scan()
  for (let count = 0; token !== ts.SyntaxKind.EndOfFileToken && count < 100_000; count++) {
    tokens.push({ type: token, text: scanner.getTokenText() })
    token = scanner.scan()
  }
  // Fail closed instead of hashing a shared prefix of two exceptionally large
  // callables and presenting that collision as duplication evidence.
  if (token !== ts.SyntaxKind.EndOfFileToken) return undefined
  return implementationFingerprint(tokens)
}

/** Program tokens plus the otherwise-comment-shaped directives a compiler consumes. */
export function typescriptSourceFingerprint(source: string): string | undefined {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source)
  const tokens: { type: string | number; text: string }[] = []
  let token = scanner.scan()
  for (let count = 0; token !== ts.SyntaxKind.EndOfFileToken && count < 100_000; count++) {
    tokens.push({ type: token, text: scanner.getTokenText() })
    token = scanner.scan()
  }
  if (token !== ts.SyntaxKind.EndOfFileToken) return undefined
  for (const directive of semanticDirectives(source)) {
    tokens.push({ type: '__semantic_directive__', text: directive })
  }
  return implementationFingerprint(tokens)
}

/** Stable hash of compiler-visible tokens; comments and layout never enter it. */
export function implementationFingerprint(tokens: readonly { type: string | number; text: string }[]): string {
  const hash = createHash('sha256')
  for (const token of tokens) {
    hash.update(JSON.stringify([token.type, token.text])).update('\n')
  }
  return hash.digest('hex')
}
