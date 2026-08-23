import { readFileSync, readdirSync, statSync } from 'node:fs'
import { decode, lines as splitLines } from './text.js'
import { join } from 'node:path'
import { insideRepo, isSymlink, repoPath } from './fspolicy.js'
import { packFor } from './lang/packs.js'
import type { ChangedFile } from './types.js'

const TS_CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * A scan covers every language the tool claims to review, not only the two the
 * TypeScript compiler reads. Walking only JS/TS meant `psh scan` on a Go or Python
 * repository reported a clean tree it had never opened.
 */
function isCode(name: string): boolean {
  return TS_CODE.test(name) || packFor(name) !== undefined
}
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', 'out'])

/** No base revision, so the before/after verifiers stay silent by construction. */
export function scanPaths(root: string, target: string): ChangedFile[] {
  const out: ChangedFile[] = []

  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      // a link inside the repository can point anywhere, and a scan feeds what it
      // reads to the judges — the boundary has to hold here, not only in their tools
      if (isSymlink(full) || !insideRepo(root, full)) continue
      const stat = statSync(full, { throwIfNoEntry: false })
      if (!stat) continue
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!isCode(name)) continue
      const lines = splitLines(decode(readFileSync(full))).length
      out.push({
        path: repoPath(root, full),
        added: new Set(Array.from({ length: lines }, (_, i) => i + 1)),
        before: undefined,
      })
    }
  }

  const start = insideRepo(root, target)
  if (!start) return out
  const stat = statSync(start, { throwIfNoEntry: false })
  if (stat?.isFile()) {
    if (isSymlink(start)) return out
    const lines = splitLines(decode(readFileSync(start))).length
    out.push({ path: repoPath(root, start), added: new Set(Array.from({ length: lines }, (_, i) => i + 1)) })
  } else {
    walk(start)
  }
  return out
}
