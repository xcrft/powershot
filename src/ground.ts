import { Project, SyntaxKind, type SourceFile } from 'ts-morph'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { decode } from './text.js'
import { join, dirname } from 'node:path'
import type { ChangedFile, ForeignFile, Ground } from './types.js'
import { packFor, parse } from './lang/packs.js'
import { insideRepo, isSymlink, repoPath } from './fspolicy.js'

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

export function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Walks up, but never past `stop`.
 *
 * A tsconfig above the repository is somebody else's, and letting one configure the
 * program that reviews this repository lets a parent directory decide what is
 * type-checked and where paths resolve to.
 */
function findUp(from: string, name: string, stop = from): string | undefined {
  let dir = from
  for (;;) {
    const p = join(dir, name)
    if (existsSync(p)) return p
    if (dir === stop) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function depsIn(pkgPath: string): Set<string> {
  const deps = new Set<string>()
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) deps.add(name)
    }
  } catch {
    // an unparseable manifest means we cannot claim a dep is missing
  }
  return deps
}

/**
 * Dependencies visible to one file, which in a workspace is not the same as the
 * repository's. A monorepo declares react in apps/web/package.json and nowhere else,
 * so reading only the root manifest would call every real dependency phantom.
 */
function makeDepsFor(root: string): (absPath: string) => Set<string> {
  const cache = new Map<string, Set<string>>()

  return (absPath: string): Set<string> => {
    let dir = dirname(absPath)
    const cached = cache.get(dir)
    if (cached) return cached

    const deps = new Set<string>()
    for (;;) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) for (const d of depsIn(pkgPath)) deps.add(d)
      if (dir === root || dirname(dir) === dir) break
      dir = dirname(dir)
    }
    cache.set(dirname(absPath), deps)
    return deps
  }
}

/**
 * Build the oracle once per run: a type-checked project over the working tree,
 * a syntax-only project holding the base-ref versions, and a symbol index.
 */
export async function buildGround(root: string, changed: ChangedFile[], signal?: AbortSignal): Promise<Ground> {
  const tsConfigFilePath = findUp(root, 'tsconfig.json')
  const typed = Boolean(tsConfigFilePath)

  const project = typed
    ? new Project({ tsConfigFilePath })
    : new Project({ compilerOptions: { allowJs: true, checkJs: false } })

  if (!typed) project.addSourceFilesAtPaths([`${root}/**/*.{ts,tsx,js,jsx,mts,cts}`, `!${root}/**/node_modules/**`])

  // What the tsconfig itself owns. A file added past this point is present for
  // reading, but the checker has no program for it — asking one for diagnostics
  // throws from inside TypeScript, which took the whole review down with it.
  const owned = new Set<string>(project.getSourceFiles().map((f) => repoPath(root, String(f.getFilePath()))))

  // A changed file may be new, or excluded from tsconfig — make sure it is present.
  // `readable` is the gate for every file that becomes reviewable: the glob above
  // follows symlinks, so passing this on the way in is not enough on its own.
  const readable = (path: string): string | undefined => {
    const abs = insideRepo(root, path)
    return abs && !isSymlink(abs) ? abs : undefined
  }

  for (const c of changed) {
    if (!CODE_EXT.test(c.path)) continue
    const abs = readable(c.path)
    if (!abs) continue
    if (!project.getSourceFile(abs) && existsSync(abs)) project.addSourceFileAtPath(abs)
  }

  const beforeProject = new Project({ useInMemoryFileSystem: true })
  const files: Ground['files'] = []
  for (const c of changed) {
    if (!CODE_EXT.test(c.path)) continue
    const abs = readable(c.path)
    if (!abs) continue
    const sf = project.getSourceFile(abs)
    if (!sf) continue
    const before =
      c.before === undefined ? undefined : beforeProject.createSourceFile(`/before/${c.path}`, c.before, { overwrite: true })
    files.push({ sf, changed: c, before, typed: typed && owned.has(repoPath(root, c.path)) })
  }

  return {
    root,
    project,
    beforeProject,
    changed,
    files,
    symbolIndex: buildSymbolIndex(project, root),
    deps: makeDepsFor(root)(join(root, 'x.ts')),
    depsFor: makeDepsFor(root),
    typed,
    internalPrefixes: pathAliasPrefixes(project, root),
    foreign: await parseForeign(root, changed, signal),
    envManifest: readEnvManifest(root),
  }
}

/**
 * Prefixes that `compilerOptions.paths` maps back into the repo — `@/*` and friends.
 * They look like package names but resolve to local files, so treating them as
 * dependencies would be wrong.
 */
function pathAliasPrefixes(project: Project, root: string): string[] {
  const prefixes = new Set<string>()
  for (const pattern of Object.keys(project.getCompilerOptions().paths ?? {})) {
    prefixes.add(pattern.replace(/\*$/, ''))
  }
  // a workspace declares its aliases in each package's tsconfig, and the root config
  // often only `extends` a shared base — so the root's paths are not the whole story
  for (const file of tsconfigsIn(root)) {
    try {
      const raw = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
      const parsed = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1'))
      for (const pattern of Object.keys(parsed?.compilerOptions?.paths ?? {})) {
        prefixes.add(String(pattern).replace(/\*$/, ''))
      }
    } catch {
      // an unreadable or non-standard tsconfig simply contributes no aliases
    }
  }
  return [...prefixes]
}

/** every tsconfig in the repo, capped so a huge monorepo cannot stall the run */
function tsconfigsIn(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length > 60) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name === 'tsconfig.json') out.push(full)
    }
  }
  walk(root, 0)
  return out
}

/**
 * Changed files the TypeScript project cannot hold. Nine of the checks need only a
 * parse tree, so a Python or Go file is reviewable the moment its grammar loads —
 * the four that need types simply do not run on it.
 */
const ENV_MANIFESTS = ['.env.example', '.env.sample', '.env.template', '.env.defaults', '.env.dist']

/**
 * Keys declared in whatever env manifest the repo keeps. Read once here rather than
 * per verifier, so every language's phantom-config compares against the same truth.
 */
export function readEnvManifest(root: string): { keys: Set<string>; file: string } | undefined {
  for (const name of ENV_MANIFESTS) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const keys = new Set<string>()
    for (const line of decode(readFileSync(path)).split(/\r?\n/)) {
      // A commented entry is how a template documents an optional variable —
      // `# OPENAI_BASE_URL=` says the name exists and may be left unset, so treating
      // it as undeclared reports the very file that documents it.
      const match = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
      if (match?.[1]) keys.add(match[1])
    }
    return { keys, file: name }
  }
  return undefined
}

async function parseForeign(root: string, changed: ChangedFile[], signal?: AbortSignal): Promise<ForeignFile[]> {
  const out: ForeignFile[] = []
  for (const c of changed) {
    // parsing thousands of files is where a large scan spends its time, so a signal
    // has to be honoured here rather than only once the checks begin
    if (signal?.aborted) break
    const pack = packFor(c.path)
    if (!pack) continue
    const abs = insideRepo(root, c.path)
    if (!abs || !existsSync(abs)) continue
    // a generated or minified file is not source anyone reviews, and parsing one
    // costs seconds to produce findings nobody acts on
    if ((statSync(abs, { throwIfNoEntry: false })?.size ?? 0) > 512 * 1024) continue
    const tree = await parse(pack, decode(readFileSync(abs)))
    if (!tree) continue
    const beforeTree = c.before === undefined ? undefined : await parse(pack, c.before)
    out.push({ path: c.path, pack, tree, beforeTree, changed: c })
  }
  return out
}

function buildSymbolIndex(project: Project, root: string): Ground['symbolIndex'] {
  const index: Ground['symbolIndex'] = new Map()
  for (const sf of project.getSourceFiles()) {
    const path = String(sf.getFilePath())
    // the project glob follows symlinked directories, so what it loaded is not
    // proof of where the file is
    if (path.includes('/node_modules/') || !insideRepo(root, path)) continue
    for (const [name, decls] of sf.getExportedDeclarations()) {
      const decl = decls[0]
      if (!decl) continue
      // only index things that could plausibly be reimplemented
      const kind = decl.getKind()
      if (
        kind !== SyntaxKind.FunctionDeclaration &&
        kind !== SyntaxKind.VariableDeclaration &&
        kind !== SyntaxKind.ClassDeclaration
      )
        continue
      // a barrel re-exports another module's symbol, so record where it is actually
      // declared — otherwise `export * from './x'` makes every symbol look duplicated
      const declPath = String(decl.getSourceFile().getFilePath())
      if (declPath.includes('/node_modules/') || !insideRepo(root, declPath)) continue
      const rel = repoPath(root, declPath)
      const key = normalizeName(name)
      const list = index.get(key) ?? []
      if (list.some((e) => e.file === rel && e.line === decl.getStartLineNumber())) continue
      list.push({ file: rel, name, line: decl.getStartLineNumber() })
      index.set(key, list)
    }
  }
  return index
}

/**
 * Resolve an absolute position into the line and column a reader can point at.
 * Verifiers use this so a finding marks the exact token, not just the line.
 */
export function locate(
  sf: SourceFile,
  start: number,
  length: number,
): { line: number; span: { column: number; length: number } } {
  const { line, column } = sf.getLineAndColumnAtPos(start)
  return { line, span: { column, length } }
}

export function locateNode(node: {
  getStart(): number
  getWidth(): number
  getSourceFile(): SourceFile
}): { line: number; span: { column: number; length: number } } {
  return locate(node.getSourceFile(), node.getStart(), node.getWidth())
}

export function relPath(sf: SourceFile, root: string): string {
  return repoPath(root, sf.getFilePath())
}
