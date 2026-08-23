import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Finding } from './types.js'

const FILE = '.powershot/judge-cache.json'
const MAX_ENTRIES = 2000

type Entry = { findings: Finding[]; seen: string }

function readTree(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * A per-repository cache the reviewed tree has no way to reach. POWERSHOT_CACHE_DIR
 * lets CI point it at something it restores between runs.
 */
function outsideTree(root: string): string {
  const home =
    process.env.POWERSHOT_CACHE_DIR ??
    process.env.XDG_CACHE_HOME ??
    join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache')
  const id = createHash('sha256').update(repositoryIdentity(root)).digest('hex').slice(0, 32)
  const file = join(home, 'powershot', id, 'judge-cache.json')
  assertOutside(root, file)
  return file
}

function realOf(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

function repositoryIdentity(root: string): string {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    } catch {
      return undefined
    }
  }
  const remote = git(['config', '--get', 'remote.origin.url'])
  if (remote) return 'remote:' + remote
  const roots = git(['rev-list', '--max-parents=0', '--all'])
  if (roots) return 'roots:' + roots.split('\n').sort().join(',')
  return 'path:' + realOf(root)
}

/** Resolve the nearest existing ancestor, so nonexistent paths and symlink parents are safe. */
function canonical(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(basename(current))
    current = parent
  }
  return join(realOf(current), ...tail)
}

function assertOutside(root: string, file: string): void {
  const rel = relative(canonical(root), canonical(file))
  const inside = rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
  if (inside) {
    throw new Error('POWERSHOT_CACHE_DIR must resolve outside the reviewed repository')
  }
}

/** Judge answers keyed by every input that can change the answer. */
export class JudgeCache {
  private constructor(
    private readonly file: string,
    private readonly entries: Record<string, Entry>,
    private readonly reviewedRoot?: string,
  ) {}

  /** Gated runs share a per-repository cache that the reviewed tree cannot write. */
  static open(root: string, gated = false): JudgeCache {
    const file = gated ? outsideTree(root) : join(root, FILE)
    const text = readTree(file)
    if (text === undefined) return new JudgeCache(file, {}, gated ? root : undefined)
    try {
      const parsed: unknown = JSON.parse(text)
      const entries = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, Entry>
        : {}
      return new JudgeCache(file, entries, gated ? root : undefined)
    } catch {
      return new JudgeCache(file, {}, gated ? root : undefined) // a corrupt cache is not worth failing a review over
    }
  }

  /** Everything an answer depends on. Leave one out and the key collides. */
  static key(parts: {
    judge: string
    provider: string
    model: string
    /** the exact text, so a reworded judge invalidates its own answers */
    prompt: string
    tools: boolean
    content: string
    intent?: string
  }): string {
    return createHash('sha256')
      .update(parts.judge)
      .update(' ')
      .update(parts.provider)
      .update(' ')
      .update(parts.model)
      .update(' ')
      .update(parts.prompt)
      .update(' ')
      .update(parts.tools ? 'tools' : 'no-tools')
      .update(' ')
      .update(parts.content)
      .update(' ')
      .update(parts.intent ?? '')
      .digest('hex')
      .slice(0, 32)
  }

  get(key: string): Finding[] | undefined {
    return this.entries[key]?.findings
  }

  put(key: string, findings: Finding[], now: string): void {
    this.entries[key] = { findings, seen: now }
  }

  /** Once at the end: a disk write per model call would eat what the cache saves. */
  save(): void {
    if (this.reviewedRoot) assertOutside(this.reviewedRoot, this.file)
    try {
      const keys = Object.keys(this.entries)
      if (keys.length > MAX_ENTRIES) {
        // oldest first, so a long-lived repository does not grow a cache without bound
        const ordered = keys.sort((a, b) => (this.entries[a]!.seen < this.entries[b]!.seen ? -1 : 1))
        for (const k of ordered.slice(0, keys.length - MAX_ENTRIES)) delete this.entries[k]
      }
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = this.file + '.tmp-' + process.pid
      writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch {
      // failing to persist a cache must never fail the review it was speeding up
    }
  }

  get size(): number {
    return Object.keys(this.entries).length
  }
}
