import { Project, SyntaxKind, type SourceFile } from 'ts-morph'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { decode } from './text.js'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChangedFile, ForeignFile, Ground } from './types.js'
import { PACKS, packFor, parseIsolated } from './lang/packs.js'
import { insideRepo, isSymlink, repoPath } from './fspolicy.js'
import { createReinventionScopeResolver, typescriptImplementationFingerprint } from './reinvention.js'

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TS_CONFIG = /^tsconfig(?:\..+)?\.json$/i
const MISSING_TYPE_PREFIXES = [
  'Cannot find global type',
  'Cannot find global value',
  'Cannot find module',
  'Cannot find name',
  'Cannot find type definition file',
  'Could not find a declaration file for module',
]

/**
 * A property diagnostic is only exact when the file's ambient types resolved.
 * Missing modules, globals, or declaration files can remove interface
 * augmentations and manufacture downstream errors such as `ImportMeta.url`.
 */
function hasTypeEnvironmentGap(sf: SourceFile): boolean {
  return sf.getPreEmitDiagnostics().some((diagnostic) => {
    const message = diagnostic.getMessageText()
    const head = typeof message === 'string' ? message : message.getMessageText()
    return MISSING_TYPE_PREFIXES.some((prefix) => head.startsWith(prefix)) || /^File .+ not found/.test(head)
  })
}

export function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '')
}

type ConfiguredProject = {
  configPath: string
  project: Project
  /** Files TypeScript loaded from the config before PowerShot added excluded changes. */
  owned: Set<string>
  /** Ancestors of owned source directories, used to choose the closest leaf config. */
  sourceAncestors: Set<string>
  sourceCount: number
}

/** A lexical repository containment check for paths that have already been resolved. */
function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** Directories from a changed file up to the repository root, nearest first. */
function ancestorDirectories(root: string, absPath: string): string[] {
  const out: string[] = []
  let dir = dirname(absPath)
  while (isWithin(root, dir)) {
    out.push(dir)
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/** Only inspect the directory chain of changed files; never crawl the monorepo. */
function configsInDirectory(dir: string, cache: Map<string, string[]>): string[] {
  const known = cache.get(dir)
  if (known) return known

  let configs: string[] = []
  try {
    configs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && TS_CONFIG.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort()
  } catch {
    // An unreadable ancestor contributes no project; the file remains syntax-only.
  }
  cache.set(dir, configs)
  return configs
}

function configuredProject(root: string, configPath: string): ConfiguredProject | undefined {
  try {
    const project = new Project({ tsConfigFilePath: configPath })
    const owned = new Set<string>()
    const sourceAncestors = new Set<string>()

    for (const sf of project.getSourceFiles()) {
      const abs = resolve(sf.getFilePath())
      const safe = insideRepo(root, abs)
      if (!safe || repoPath(root, abs).split('/').includes('node_modules')) continue
      owned.add(repoPath(root, abs))

      let dir = dirname(abs)
      while (isWithin(root, dir)) {
        sourceAncestors.add(dir)
        if (dir === root) break
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }

    return { configPath, project, owned, sourceAncestors, sourceCount: owned.size }
  } catch {
    // A broken candidate beside a usable leaf config must not take down the review.
    return undefined
  }
}

function directoryDepth(root: string, dir: string): number {
  const rel = repoPath(root, dir)
  return rel === '' ? 0 : rel.split('/').length
}

function sourceAffinity(root: string, candidate: ConfiguredProject, absPath: string): number {
  let dir = dirname(absPath)
  while (isWithin(root, dir)) {
    if (candidate.sourceAncestors.has(dir)) return directoryDepth(root, dir)
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return -1
}

function nameAffinity(root: string, configPath: string, absPath: string): number {
  const base = basename(configPath)
  const name = base.slice('tsconfig'.length, -'.json'.length).replace(/^\./, '')
  if (name === '') return 0
  const tokens = new Set(
    repoPath(root, absPath).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  )
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => tokens.has(token)).length
}

/** Prefer the leaf project whose existing sources live closest to this file. */
function bestProject(root: string, candidates: ConfiguredProject[], absPath: string): ConfiguredProject {
  return [...candidates].sort(
    (a, b) =>
      sourceAffinity(root, b, absPath) - sourceAffinity(root, a, absPath) ||
      nameAffinity(root, b.configPath, absPath) - nameAffinity(root, a.configPath, absPath) ||
      a.sourceCount - b.sourceCount ||
      a.configPath.localeCompare(b.configPath),
  )[0]!
}

function looksLikeTest(path: string): boolean {
  return /(?:^|[/\\])(?:__tests__|tests?)(?:[/\\]|$)/i.test(path) || /\.(?:test|spec)\.[^.]+$/i.test(path)
}

/**
 * Resolve one changed file at the nearest useful project boundary.
 *
 * Solution configs (`files: []`) do not claim a type environment. If a sibling leaf
 * config owns the file it wins; if every leaf excludes the file (common for tests),
 * the closest suitable non-empty leaf supplies compiler options and references.
 * Selecting that local leaf avoids opening a repository-wide parent.
 */
function projectForFile(
  root: string,
  absPath: string,
  directoryCache: Map<string, string[]>,
  projectCache: Map<string, ConfiguredProject | undefined>,
): ConfiguredProject | undefined {
  const rel = repoPath(root, absPath)
  for (const dir of ancestorDirectories(root, absPath)) {
    const configPaths = [...configsInDirectory(dir, directoryCache)].sort((a, b) =>
      nameAffinity(root, b, absPath) - nameAffinity(root, a, absPath) || a.localeCompare(b),
    )
    const projects: ConfiguredProject[] = []
    for (const configPath of configPaths) {
      if (!projectCache.has(configPath)) {
        projectCache.set(configPath, configuredProject(root, configPath))
      }
      const project = projectCache.get(configPath)
      if (!project) continue
      // Config names such as `test`, `app`, and `node` are ranked against the file
      // path, so the first owner is the most specific without opening every sibling.
      if (project.owned.has(rel)) return project
      projects.push(project)
    }

    const boundaryDepth = directoryDepth(root, dir)
    const leaves = projects.filter((project) =>
      project.sourceCount > 0 &&
      (sourceAffinity(root, project, absPath) > boundaryDepth || looksLikeTest(absPath)),
    )
    if (leaves.length > 0) return bestProject(root, leaves, absPath)
  }
  return undefined
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
 * Build the oracle once per run: focused type-checked projects for the changed
 * packages, a syntax-only project for unconfigured changes and the base-ref trees,
 * and one deduplicated symbol index over the relevant project closures.
 */
export async function buildGround(root: string, changed: ChangedFile[], signal?: AbortSignal): Promise<Ground> {
  root = resolve(root)
  const directoryCache = new Map<string, string[]>()
  const projectCache = new Map<string, ConfiguredProject | undefined>()
  const selectedProjects = new Set<ConfiguredProject>()
  const assigned = new Map<string, ConfiguredProject>()
  const syntaxProject = new Project({ compilerOptions: { allowJs: true, checkJs: false } })

  // `readable` is the gate for every file that becomes reviewable. A tsconfig glob
  // can follow symlinks, so selected project closures are checked again below too.
  const readable = (path: string): string | undefined => {
    const abs = insideRepo(root, path)
    return abs && !isSymlink(abs) ? abs : undefined
  }

  for (const c of changed) {
    if (signal?.aborted) break
    if (!CODE_EXT.test(c.path)) continue
    const abs = readable(c.path)
    if (!abs || !existsSync(abs)) continue

    const configured = projectForFile(root, abs, directoryCache, projectCache)
    if (configured) {
      selectedProjects.add(configured)
      assigned.set(c.path, configured)
      // Tests and tooling files are often excluded from the production build config.
      // Adding one explicitly keeps the leaf project's compiler options and imports.
      if (!configured.project.getSourceFile(abs)) configured.project.addSourceFileAtPath(abs)
    } else if (!syntaxProject.getSourceFile(abs)) {
      // No recursive glob: a configless million-file repository still loads only the
      // files in the review.
      syntaxProject.addSourceFileAtPath(abs)
    }
  }

  const beforeProject = new Project({ useInMemoryFileSystem: true })
  const files: Ground['files'] = []
  for (const c of changed) {
    if (!CODE_EXT.test(c.path)) continue
    const abs = readable(c.path)
    if (!abs) continue
    const configured = assigned.get(c.path)
    const sf = configured?.project.getSourceFile(abs) ?? syntaxProject.getSourceFile(abs)
    if (!sf) continue
    const before =
      c.before === undefined ? undefined : beforeProject.createSourceFile(`/before/${c.path}`, c.before, { overwrite: true })
    files.push({
      sf,
      changed: c,
      before,
      // A bound program with unresolved ambient types is not an exact type oracle.
      // Keep the file reviewable, but make type-dependent checks explicitly partial.
      typed: configured !== undefined && !hasTypeEnvironmentGap(sf),
    })
  }

  const projects = [...selectedProjects].map((selected) => selected.project)
  if (syntaxProject.getSourceFiles().length > 0) projects.push(syntaxProject)
  const sourceFiles = uniqueSourceFiles(root, files.map((file) => file.sf), projects)
  const configFiles = [...selectedProjects]
    .map((selected) => repoPath(root, selected.configPath))
    .sort()
  const typed = files.some((file) => file.typed)
  const depsFor = makeDepsFor(root)

  return {
    root,
    sourceFiles,
    configFiles,
    beforeProject,
    changed,
    files,
    symbolIndex: buildSymbolIndex(sourceFiles, root, changed, beforeProject),
    deps: depsFor(join(root, 'x.ts')),
    depsFor,
    typed,
    internalPrefixes: pathAliasPrefixes(projects),
    foreign: await parseForeign(root, changed, signal),
    envManifest: readEnvManifest(root),
  }
}

/** Prefer changed-file SourceFiles, then add each relevant project source once. */
function uniqueSourceFiles(root: string, preferred: SourceFile[], projects: Project[]): SourceFile[] {
  const byPath = new Map<string, SourceFile>()
  const add = (sf: SourceFile): void => {
    const abs = resolve(sf.getFilePath())
    if (!insideRepo(root, abs)) return
    const rel = repoPath(root, abs)
    if (rel.split('/').includes('node_modules') || byPath.has(rel)) return
    byPath.set(rel, sf)
  }
  for (const sf of preferred) add(sf)
  for (const project of projects) for (const sf of project.getSourceFiles()) add(sf)
  return [...byPath.values()]
}

/**
 * Prefixes that `compilerOptions.paths` maps back into the repo — `@/*` and friends.
 * They look like package names but resolve to local files, so treating them as
 * dependencies would be wrong.
 */
function pathAliasPrefixes(projects: Project[]): string[] {
  const prefixes = new Set<string>()
  for (const project of projects) {
    for (const pattern of Object.keys(project.getCompilerOptions().paths ?? {})) {
      prefixes.add(pattern.replace(/\*$/, ''))
    }
  }
  return [...prefixes]
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
  type Candidate = { changed: ChangedFile; source: string; beforeSource?: string }
  const byLanguage = new Map<string, Candidate[]>()
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
    const list = byLanguage.get(pack.name) ?? []
    list.push({
      changed: c,
      source: decode(readFileSync(abs)),
      // A generated base can be arbitrarily larger than the reviewed result. Do not
      // smuggle it past the current-file limit through the before/after channel.
      beforeSource: c.before !== undefined && Buffer.byteLength(c.before) <= 512 * 1024
        ? c.before
        : undefined,
    })
    byLanguage.set(pack.name, list)
  }

  const parsed = new Map<string, ForeignFile>()
  // A worker holds one grammar and a bounded source batch. This keeps both WASM
  // compilation and structured-clone payloads independent of monorepo size.
  const MAX_BATCH_BYTES = 8 * 1024 * 1024
  const MAX_BATCH_FILES = 128
  for (const pack of PACKS) {
    const candidates = byLanguage.get(pack.name) ?? []
    for (let start = 0; start < candidates.length;) {
      let end = start
      let bytes = 0
      while (end < candidates.length && end - start < MAX_BATCH_FILES) {
        const candidate = candidates[end]!
        const next = Buffer.byteLength(candidate.source) + Buffer.byteLength(candidate.beforeSource ?? '')
        if (end > start && bytes + next > MAX_BATCH_BYTES) break
        bytes += next
        end++
      }

      const batch = candidates.slice(start, end)
      const sources = batch.flatMap((candidate) =>
        candidate.beforeSource === undefined
          ? [candidate.source]
          : [candidate.source, candidate.beforeSource],
      )
      const trees = await parseIsolated(pack, sources, signal)
      let index = 0
      for (const candidate of batch) {
        const tree = trees[index++]
        const beforeTree = candidate.beforeSource === undefined ? undefined : trees[index++]
        if (!tree) continue
        parsed.set(candidate.changed.path, {
          path: candidate.changed.path,
          pack,
          tree,
          beforeTree,
          changed: candidate.changed,
        })
      }
      start = end
      if (signal?.aborted) break
    }
    if (signal?.aborted) break
  }
  return changed.flatMap((file) => {
    const result = parsed.get(file.path)
    return result ? [result] : []
  })
}

function buildSymbolIndex(
  sourceFiles: SourceFile[],
  root: string,
  changed: ChangedFile[],
  beforeProject: Project,
): Ground['symbolIndex'] {
  const index: Ground['symbolIndex'] = new Map()
  const changes = new Map(changed.map((file) => [file.path, file]))
  const scopeFor = createReinventionScopeResolver(root)
  const relevantNames = new Set<string>()
  for (const sf of sourceFiles) {
    const rel = repoPath(root, String(sf.getFilePath()))
    if (!changes.has(rel)) continue
    for (const declaration of sf.getFunctions()) {
      const name = declaration.getName()
      if (name) relevantNames.add(normalizeName(name))
    }
    for (const declaration of sf.getVariableDeclarations()) {
      const initializer = declaration.getInitializer()
      if (initializer?.isKind(SyntaxKind.ArrowFunction) || initializer?.isKind(SyntaxKind.FunctionExpression)) {
        relevantNames.add(normalizeName(declaration.getName()))
      }
    }
  }
  for (const sf of sourceFiles) {
    const path = String(sf.getFilePath())
    // the project glob follows symlinked directories, so what it loaded is not
    // proof of where the file is
    if (path.includes('/node_modules/') || !insideRepo(root, path)) continue
    for (const [name, decls] of sf.getExportedDeclarations()) {
      const key = normalizeName(name)
      // Fingerprint only names the change could have introduced. This keeps index
      // construction proportional to the diff even when the project closure is a
      // very large monorepo.
      if (!relevantNames.has(key)) continue
      const decl = decls[0]
      if (!decl) continue
      // only index things that could plausibly be reimplemented
      const kind = decl.getKind()
      if (
        kind !== SyntaxKind.FunctionDeclaration &&
        kind !== SyntaxKind.VariableDeclaration
      )
        continue
      const fingerprint = typescriptImplementationFingerprint(decl)
      if (!fingerprint) continue
      // A barrel alias can be new in this change even when its underlying callable
      // predates it. Index the declaration from its own module, where both its name
      // and base existence can be proved, rather than manufacturing history for the
      // new alias or recording every `export *` as another copy.
      if (decl.getSourceFile() !== sf) continue
      const declPath = String(decl.getSourceFile().getFilePath())
      if (declPath.includes('/node_modules/') || !insideRepo(root, declPath)) continue
      const rel = repoPath(root, declPath)
      const change = changes.get(rel)
      const before = change?.before === undefined ? undefined : beforeProject.getSourceFile('/before/' + rel)
      const existedInBase = change === undefined || (before?.getExportedDeclarations().get(name) ?? []).some(
        (baseDeclaration) => typescriptImplementationFingerprint(baseDeclaration) === fingerprint,
      )
      const list = index.get(key) ?? []
      if (list.some((e) => e.file === rel && e.line === decl.getStartLineNumber())) continue
      list.push({
        file: rel,
        name,
        line: decl.getStartLineNumber(),
        fingerprint,
        existedInBase,
        scope: scopeFor(rel),
      })
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
