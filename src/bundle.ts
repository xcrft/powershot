import type { ForeignFile, Ground } from './types.js'
import { relPath } from './ground.js'
import { lines as splitLines } from './text.js'

export type GroundFile = Ground['files'][number]

/**
 * What the model half needs from a file, whatever parsed it. The verifiers care
 * whether ts-morph or tree-sitter produced it; bundling and rendering do not, and
 * writing them against ts-morph is what used to drop a Python-only diff entirely.
 */
export type Reviewable = { path: string; added: Set<number>; text: string }

export type Bundle = { files: Reviewable[]; lines: number }

/** Past this a model attends to less of the file. Cut into units, never skipped. */
const MAX_LINES_PER_UNIT = 400

export const CONTEXT = 3

export function shownLines(files: Reviewable[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const f of files) {
    const seen = out.get(f.path) ?? new Set<number>()
    for (const n of f.added) for (let i = n - CONTEXT; i <= n + CONTEXT; i++) if (i >= 1) seen.add(i)
    out.set(f.path, seen)
  }
  return out
}

export function reviewableOf(f: GroundFile): Reviewable {
  return { path: f.changed.path, added: f.changed.added, text: f.sf.getFullText() }
}

export function reviewableOfForeign(f: ForeignFile): Reviewable {
  return { path: f.path, added: f.changed.added, text: f.tree.rootNode.text }
}

export function reviewables(g: Ground): Reviewable[] {
  return [...g.files.map(reviewableOf), ...g.foreign.map(reviewableOfForeign)]
}

/** Roughly what a file costs a prompt: its changed lines plus the context around them. */
function weightOf(r: Reviewable): number {
  return Math.min(r.added.size * 4, 600)
}

function chunk(r: Reviewable): Reviewable[] {
  if (r.added.size <= MAX_LINES_PER_UNIT) return [r]
  const ordered = [...r.added].sort((a, b) => a - b)
  const out: Reviewable[] = []
  for (let i = 0; i < ordered.length; i += MAX_LINES_PER_UNIT) {
    out.push({ path: r.path, added: new Set(ordered.slice(i, i + MAX_LINES_PER_UNIT)), text: r.text })
  }
  return out
}

/**
 * Files that import one another. A judge reasoning about a stale read needs caller
 * and callee at once. Only TS has a resolved import graph; foreign files pack by size.
 */
function components(g: Ground): Reviewable[][] {
  const byPath = new Map<string, GroundFile>()
  for (const f of g.files) byPath.set(f.sf.getFilePath(), f)

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const path of byPath.keys()) parent.set(path, path)

  for (const f of g.files) {
    for (const imp of f.sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile()
      if (!target) continue
      const targetPath = target.getFilePath()
      if (byPath.has(targetPath)) union(f.sf.getFilePath(), targetPath)
    }
  }

  const groups = new Map<string, Reviewable[]>()
  for (const [path, f] of byPath) {
    const root = find(path)
    const list = groups.get(root) ?? []
    list.push(reviewableOf(f))
    groups.set(root, list)
  }
  const out = [...groups.values()]

  const byKey = new Map<string, Reviewable[]>()
  for (const f of g.foreign) {
    const key = groupKey(f.path)
    const list = byKey.get(key) ?? []
    list.push(reviewableOfForeign(f))
    byKey.set(key, list)
  }
  out.push(...byKey.values())
  return out
}

/** Keep related files together while bin-packing to minimize model calls. */
export function bundle(g: Ground, maxLines: number): Bundle[] {
  const groups = components(g)
    .map((files) => files.flatMap(chunk))
    .map((files) => ({ files, lines: files.reduce((n, f) => n + weightOf(f), 0) }))
    .sort((a, b) => b.lines - a.lines)

  const bundles: Bundle[] = []
  for (const group of groups) {
    // better a split component than one prompt the model reads the beginning of
    if (group.lines > maxLines && group.files.length > 1) {
      let current: Bundle = { files: [], lines: 0 }
      for (const f of group.files) {
        const w = weightOf(f)
        if (current.lines + w > maxLines && current.files.length > 0) {
          bundles.push(current)
          current = { files: [], lines: 0 }
        }
        current.files.push(f)
        current.lines += w
      }
      if (current.files.length > 0) bundles.push(current)
      continue
    }

    const room = bundles.find((b) => b.lines + group.lines <= maxLines)
    if (room) {
      room.files.push(...group.files)
      room.lines += group.lines
    } else {
      bundles.push({ files: [...group.files], lines: group.lines })
    }
  }
  return bundles
}

/** Paths no unit carries. What this reports makes the run incomplete, not clean. */
export function uncovered(g: Ground, units: Bundle[]): string[] {
  const seen = new Set(units.flatMap((u) => u.files.map((f) => f.path)))
  return reviewables(g)
    .map((r) => r.path)
    .filter((p) => !seen.has(p))
}

export function bundleName(b: Bundle, root: string): string {
  const first = b.files[0]
  if (!first) return 'empty'
  // a chunked file appears in several units; the first line tells them apart
  const ordered = [...first.added].sort((a, b) => a - b)
  const suffix = ordered.length > 0 && splitLines(first.text).length > ordered.length ? '@' + ordered[0] : ''
  const name = first.path + suffix
  return b.files.length === 1 ? name : name + ' +' + (b.files.length - 1)
}

export { relPath }
/**
 * What binds two files of a language into one conversation.
 *
 * The TypeScript half has a resolved import graph; nothing else does, and packing the
 * rest by size alone put a header in one unit and its implementation in another —
 * exactly the pair a judge needs together to see a contract drift. These are the
 * cheap structural relationships each language already encodes in its paths.
 */
export function groupKey(path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const name = path.slice(dir.length)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return path
  const ext = name.slice(dot)
  const stem = name.slice(0, dot)

  // a header and its implementation are one contract written down twice
  if (/^\.(h|hpp|hh|hxx|c|cc|cpp|cxx|m|mm)$/.test(ext)) return dir + stem

  // a package is the unit in Go, Java, Kotlin and C#
  if (/^\.(go|java|kt|kts|cs)$/.test(ext)) return dir

  // elsewhere a module and the tests that cover it argue about the same behaviour
  if (/^\.(py|pyi|rs|rb|php|swift)$/.test(ext)) {
    return dir + stem.replace(/^test_/, '').replace(/_test$/, '').replace(/_spec$/, '').replace(/Test$/, '')
  }
  return path
}
