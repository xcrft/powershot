import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git } from './git.js'
import type { Range } from './git.js'

export function targetRef(range: Range): string | undefined {
  if (range.commit) return range.commit
  if (range.from) return range.to ?? 'HEAD'
  return undefined
}

/**
 * True when the working tree already *is* the target, so there is nothing to check
 * out. This is the ordinary CI case — a runner checks the head out and reviews it —
 * and skipping the copy there keeps the common path as fast as it was.
 */
function treeIsTarget(root: string, ref: string): boolean {
  try {
    if (git(root, ['rev-parse', ref]).trim() !== git(root, ['rev-parse', 'HEAD']).trim()) return false
    return git(root, ['status', '--porcelain']).trim() === ''
  } catch {
    return false
  }
}

/** A worktree holds tracked files only, so a checkout has no node_modules and every
 *  dependency import becomes unresolvable — a type-aware review of imaginary findings. */
function linkDependencies(repo: string, tree: string): void {
  const manifests = git(repo, ['ls-files', '*package.json', 'package.json'])
    .split('\n')
    .filter(Boolean)
    .map((p) => dirname(p))
  for (const dir of new Set(['.', ...manifests])) {
    const from = join(repo, dir, 'node_modules')
    const to = join(tree, dir, 'node_modules')
    if (!existsSync(from) || existsSync(to) || !existsSync(dirname(to))) continue
    try {
      symlinkSync(from, to, 'junction')
    } catch {
      // a link we cannot make degrades resolution for that package only
    }
  }
}

export type TargetTree = {
  /** the directory whose files should be analysed */
  dir: string
  /** point the same tree at another ref, without paying for a second checkout */
  checkout(ref: string): void
  close(): void
}

/**
 * A checkout of exactly the version under review.
 *
 * One thing it cannot restore: the dependencies of that version. `node_modules` is
 * linked from the current install, because the old lockfile's tree is not on disk.
 * Type resolution therefore reflects today's dependencies — which is why a replay is
 * a precision signal about the checks and not a reproduction of the original review.
 */
export function openTargetTree(repo: string, ref: string): TargetTree {
  // a run killed mid-checkout leaves a registration behind; git's own answer is one
  // command, and running it here is what keeps `git worktree list` honest over time
  try {
    git(repo, ['worktree', 'prune'])
  } catch {
    // an older git, or a repository that has never had one — nothing to clean
  }
  const parent = mkdtempSync(join(tmpdir(), 'powershot-'))
  const dir = join(parent, 'tree')
  git(repo, ['worktree', 'add', '--detach', '--quiet', dir, ref])
  linkDependencies(repo, dir)

  return {
    dir,
    checkout(next: string): void {
      execFileSync('git', ['checkout', '--detach', '--quiet', '--force', next], {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    },
    close(): void {
      try {
        git(repo, ['worktree', 'remove', '--force', dir])
      } catch {
        // the temp directory goes either way; a stale entry is pruned by git itself
      }
      rmSync(parent, { recursive: true, force: true })
    },
  }
}

/** Run something against the exact target version, cleaning up whatever it took. */
export async function withTargetTree<T>(repo: string, range: Range, fn: (dir: string) => Promise<T>): Promise<T> {
  const ref = targetRef(range)
  if (!ref || treeIsTarget(repo, ref)) return fn(repo)
  const tree = openTargetTree(repo, ref)
  try {
    return await fn(tree.dir)
  } finally {
    tree.close()
  }
}
