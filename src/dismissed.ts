import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.js'
import type { Finding } from './types.js'

const FILE = '.powershot/dismissed.json'

export type Dismissal = {
  fingerprint: string
  check: string
  file: string
  /** the line as it read when someone decided it was fine, for a reader of the file */
  code: string
  title: string
  reason?: string
  at: string
}

/**
 * Committed, unlike the judge cache: a dismissal is a team decision, not an
 * optimisation. Keyed on the line's code rather than its position, so it survives
 * code growing above it and lapses when that line itself changes.
 */
export class Dismissals {
  private constructor(
    private readonly file: string,
    private entries: Dismissal[],
  ) {}

  /** `baseRef` is what stops a change from waving through its own findings. */
  static open(root: string, baseRef?: string): Dismissals {
    const file = join(root, FILE)
    return new Dismissals(file, parse(baseRef === undefined ? fromTree(file) : fromRef(root, baseRef)))
  }

  /**
   * Fingerprints this change adds to the list, which are deliberately not in force
   * yet. Reported rather than applied: a diff that suppresses findings is a thing a
   * reviewer should be told about, not a thing that quietly succeeds.
   */
  static pendingIn(root: string, baseRef: string): number {
    const inBase = new Set(parse(fromRef(root, baseRef)).map((d) => d.fingerprint))
    return parse(fromTree(join(root, FILE))).filter((d) => !inBase.has(d.fingerprint)).length
  }

  /**
   * What a dismissal is about: this check, on this file, against this line of code.
   * The line number is not part of it — code above a defect grows all the time, and a
   * decision about a line should not expire because something unrelated moved it.
   */
  static fingerprint(f: Finding): string {
    const code = codeOf(f)
    return createHash('sha256')
      .update(f.check)
      .update(' ')
      .update(f.file)
      .update(' ')
      .update(code)
      .digest('hex')
      .slice(0, 24)
  }

  has(f: Finding): boolean {
    const fp = Dismissals.fingerprint(f)
    return this.entries.some((d) => d.fingerprint === fp)
  }

  add(f: Finding, reason: string | undefined, at: string): boolean {
    const fingerprint = Dismissals.fingerprint(f)
    if (this.entries.some((d) => d.fingerprint === fingerprint)) return false
    this.entries.push({ fingerprint, check: f.check, file: f.file, code: codeOf(f), title: f.title, reason, at })
    this.save()
    return true
  }

  remove(fingerprint: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((d) => !d.fingerprint.startsWith(fingerprint))
    if (this.entries.length === before) return false
    this.save()
    return true
  }

  list(): Dismissal[] {
    return this.entries
  }

  private save(): void {
    mkdirSync(join(this.file, '..'), { recursive: true })
    // written readably, because this file is committed and people read diffs of it
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2) + '\n')
  }
}

function fromTree(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  } catch {
    return undefined
  }
}

function fromRef(root: string, ref: string): string | undefined {
  try {
    return git(root, ['show', ref + ':' + FILE], true)
  } catch {
    return undefined // no list at that ref, which is the same as an empty one
  }
}

function parse(text: string | undefined): Dismissal[] {
  if (text === undefined) return []
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? (value as Dismissal[]) : []
  } catch {
    return [] // an unreadable list must hide nothing rather than everything
  }
}

const LAST = '.powershot/last-report.json'

/** The findings the most recent review reported, so `dismiss F2` knows what F2 was. */
export function rememberReport(root: string, findings: Finding[]): void {
  try {
    mkdirSync(join(root, '.powershot'), { recursive: true, mode: 0o700 })
    // holds source frames from the reviewed tree, so not world-readable
    writeFileSync(join(root, LAST), JSON.stringify(findings), { mode: 0o600 })
  } catch {
    // being unable to remember the last report must not fail the review itself
  }
}

export function lastReport(root: string): Finding[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, LAST), 'utf8'))
    return Array.isArray(parsed) ? (parsed as Finding[]) : []
  } catch {
    return []
  }
}

/** The line the finding is about, as it read at the time. */
function codeOf(f: Finding): string {
  const line = f.frame ? f.frame.lines[f.line - f.frame.firstLine] : undefined
  return (line ?? f.title).trim()
}
