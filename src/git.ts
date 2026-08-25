import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangedFile } from './types.js'
import { decode, lines, stripCR } from './text.js'
import { insideRepo, isSymlink } from './fspolicy.js'

export function git(root: string, args: string[], quiet = false): string {
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'],
    })
    return decode(out)
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string }
    const detail = err.stderr ? decode(err.stderr).trim() : ''
    throw new Error(detail || err.message || 'git ' + args[0] + ' failed')
  }
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}

function fileAtRef(root: string, ref: string, path: string): string | undefined {
  try {
    const record = git(root, ['ls-tree', '-z', ref, '--', ':(literal)' + path], true).split('\0')[0]
    const header = record?.slice(0, record.indexOf('\t')).split(' ')
    const oid = header?.[2]
    if (!oid || header?.[1] !== 'blob') return undefined
    return git(root, ['cat-file', 'blob', oid], true)
  } catch {
    return undefined
  }
}

/**
 * Added/modified line numbers per file, parsed from a zero-context diff.
 * Only new-side ranges matter: we review what the change introduced.
 */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let current: Set<number> | undefined
  // a CRLF diff would otherwise put `\r` inside every captured path, and nothing
  // would ever match a real file
  for (const raw of diff.split('\n')) {
    const line = stripCR(raw)
    const file = /^\+\+\+ b\/(.+)$/.exec(line)
    if (file && file[1]) {
      current = new Set<number>()
      out.set(file[1], current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && current) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let i = 0; i < count; i++) current.add(start + i)
    }
  }
  return out
}

function addedLinesInPatch(diff: string): Set<number> {
  const added = new Set<number>()
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(stripCR(raw))
    if (!hunk) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    for (let i = 0; i < count; i++) added.add(start + i)
  }
  return added
}

function changedPaths(raw: string): { path: string; beforePath?: string; deleted?: boolean }[] {
  const fields = raw.split('\0')
  const out: { path: string; beforePath?: string; deleted?: boolean }[] = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]
    if (!status) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      const beforePath = fields[i++]
      const path = fields[i++]
      if (beforePath && path) out.push({ path, beforePath })
      continue
    }
    const path = fields[i++]
    if (path) out.push({ path, beforePath: status === 'A' ? undefined : path, deleted: status === 'D' })
  }
  return out
}

export type Range = { from?: string; to?: string; commit?: string }

/**
 * A ref is an argument only once it is proven to be one.
 *
 * `execFileSync` stops the shell from interpreting a ref, but not git: an argument
 * beginning with `-` is an option, so `--from=--output=/tmp/x` makes `git diff` write
 * a file and report nothing — an arbitrary write behind a clean exit code. Resolving
 * the ref also turns a name that does not exist into an error rather than an empty
 * diff, which is the same clean-looking nothing by a different route.
 */
export function resolveRef(root: string, value: string, flag: string): string {
  if (value.startsWith('-')) throw new Error(flag + ' looks like an option, not a ref: ' + value)
  if (/[\0-\x1f\x7f]/.test(value)) throw new Error(flag + ' contains a control character')
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', value + '^{commit}'], true).trim()
  } catch {
    throw new Error(flag + ' is not a commit in this repository: ' + value)
  }
}

export function checkRange(root: string, range: Range): void {
  if (range.commit !== undefined) resolveRef(root, range.commit, '--commit')
  if (range.from !== undefined) resolveRef(root, range.from, '--from')
  if (range.to !== undefined) resolveRef(root, range.to, '--to')
}

export function mergeBase(root: string, from: string, to: string): string {
  try {
    return git(root, ['merge-base', from, to]).trim() || from
  } catch {
    return from // unrelated histories: the tip is the only base there is
  }
}

export function baseRefOf(root: string, range: Range): string {
  if (range.commit) return range.commit + '^'
  if (range.from && range.to) return mergeBase(root, range.from, range.to)
  if (range.from) return range.from
  return 'HEAD'
}

/**
 * What the change says it does, taken from commit subjects. Workspace mode has no
 * commit yet, so it has no stated intent — the intent judge simply does not run.
 */
export function statedIntent(root: string, range: Range): string | undefined {
  try {
    if (range.commit) return git(root, ['log', '-1', '--pretty=%B', range.commit]).trim() || undefined
    if (range.from && range.to) {
      return git(root, ['log', '--pretty=- %s', range.from + '..' + range.to]).trim() || undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

export function collectChanges(root: string, range: Range): ChangedFile[] {
  checkRange(root, range)

  // An unborn repository has no HEAD to diff against. Every present file is new, so
  // reading the index and working tree directly is both simpler and more accurate
  // than inventing a base commit (including for staged files edited again afterwards).
  if (!range.commit && !range.from && !shaOf(root, 'HEAD')) {
    const paths = new Set([
      ...git(root, ['ls-files', '-z', '--cached']).split('\0').filter(Boolean),
      ...git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean),
    ])
    const files: ChangedFile[] = []
    for (const path of paths) {
      const abs = insideRepo(root, path)
      if (!abs || isSymlink(abs) || !existsSync(abs)) continue
      const count = lines(decode(readFileSync(abs))).length
      files.push({ path, added: new Set(Array.from({ length: count }, (_, i) => i + 1)), before: undefined })
    }
    return files
  }

  let diffArgs: string[]
  let baseRef: string

  if (range.commit) {
    baseRef = range.commit + '^'
    diffArgs = [range.commit + '^', range.commit]
  } else if (range.from && range.to) {
    // `diff A...B` is measured from the merge base, so the base content has to come
    // from there too. Reading it from the branch tip instead lines up new-side line
    // numbers with a version of the file the diff never looked at.
    baseRef = mergeBase(root, range.from, range.to)
    diffArgs = [range.from + '...' + range.to]
  } else {
    baseRef = 'HEAD'
    diffArgs = ['HEAD']
  }

  const files: ChangedFile[] = []
  const tracked = changedPaths(git(root, [
    'diff', '--name-status', '-z', '--diff-filter=ACDMRT', '--find-renames', ...diffArgs,
  ]))
  for (const { path, beforePath, deleted } of tracked) {
    const pathspecs = beforePath && beforePath !== path
      ? [':(literal)' + beforePath, ':(literal)' + path]
      : [':(literal)' + path]
    const patch = git(root, [
      'diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames',
      ...diffArgs, '--', ...pathspecs,
    ])
    files.push({
      path,
      beforePath: beforePath && beforePath !== path ? beforePath : undefined,
      deleted,
      added: addedLinesInPatch(patch),
      before: beforePath === undefined ? undefined : fileAtRef(root, baseRef, beforePath),
    })
  }

  if (!range.commit && !range.from) {
    const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)
    for (const path of untracked) {
      // an untracked symlink can point anywhere, and what a review reads it can send
      const abs = insideRepo(root, path)
      if (!abs || isSymlink(abs) || !existsSync(abs)) continue
      const count = lines(decode(readFileSync(abs))).length
      files.push({ path, added: new Set(Array.from({ length: count }, (_, i) => i + 1)), before: undefined })
    }
  }
  return files
}

export function shaOf(root: string, ref: string): string | undefined {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], true).trim() || undefined
  } catch {
    return undefined
  }
}

export function headSha(root: string): string | undefined {
  return shaOf(root, 'HEAD')
}
