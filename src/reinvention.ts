import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  Node,
  ts,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
} from 'ts-morph'
import { insideRepo, repoPath } from './fspolicy.js'

type Callable = FunctionDeclaration | ArrowFunction | FunctionExpression

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

/**
 * Exact program tokens for a callable, excluding its export modifier and declared
 * name. Layout and comments may differ; parameters, types, operators, callees and
 * literals may not. That is deliberately conservative: a name match proposes a
 * candidate, but only equivalent executable text is deterministic evidence that a
 * helper was reimplemented.
 */
export function typescriptImplementationFingerprint(node: Node): string | undefined {
  const fn = callable(node)
  const body = fn?.getBody()
  if (!fn || !body) return undefined

  const generator = !Node.isArrowFunction(fn) && fn.isGenerator()
  const source = [
    fn.isAsync() ? 'async' : 'sync',
    generator ? 'generator' : 'plain',
    '<' + fn.getTypeParameters().map((parameter) => parameter.getText()).join(',') + '>',
    '(' + fn.getParameters().map((parameter) => parameter.getText()).join(',') + ')',
    ':' + (fn.getReturnTypeNode()?.getText() ?? ''),
    body.getText(),
  ].join('\n')

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

/** Stable hash of compiler-visible tokens; comments and layout never enter it. */
export function implementationFingerprint(tokens: readonly { type: string | number; text: string }[]): string {
  const hash = createHash('sha256')
  for (const token of tokens) {
    hash.update(JSON.stringify([token.type, token.text])).update('\n')
  }
  return hash.digest('hex')
}
