import { statSync } from 'node:fs'
import { insideRepo, isSymlink } from './fspolicy.js'
import { matchesAny, type Config } from './config.js'
import { packFor } from './lang/packs.js'
import { pyrightAvailable } from './lang/pyright.js'
import type { Capability, ChangedFile, Ground } from './types.js'

/**
 * Past this a file is generated, minified or vendored rather than written. What is
 * turned away is recorded as an outcome, not printed and forgotten.
 */
const MAX_FILE_BYTES = 512 * 1024

const TS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

export type Disposition = 'selected' | 'waived' | 'failed'

export type PlanItem = {
  path: string
  disposition: Disposition
  /** why, whenever it is not simply selected */
  reason?: string
  bytes: number
  addedLines: number
  language: string
  /** Deterministic check ids that actually received this file. */
  checks: string[]
  /**
   * Capabilities this run has, that this file does not.
   *
   * A file excluded from the tsconfig sits beside one the compiler owns: the run
   * reports `types` as available and the check as run, and for this file it never
   * looked. The asymmetry is the danger — a repository with no tsconfig at all is
   * already visible in the skipped list.
   */
  missing?: Capability[]
  /** Enriched capabilities unavailable under portable coverage; visible, but not verdict-blocking. */
  unavailable?: Capability[]
}

/**
 * One answer to "what is this run about", shared by everything that needs it.
 *
 * Every file the change touches ends in exactly one disposition: reviewed, waived by
 * a policy someone wrote down, or failed because we could not look. Scattering those
 * decisions across the pipeline is what let a run turn a file away in a progress line
 * and still report the result as clean — the reader saw a summary that had no idea
 * the file existed.
 */
export class SelectionPlan {
  private constructor(private readonly rows: Map<string, PlanItem>) {}

  static build(root: string, changed: ChangedFile[], config: Config): SelectionPlan {
    const rows = new Map<string, PlanItem>()
    for (const c of changed) {
      const abs = insideRepo(root, c.path)
      const bytes = abs ? (statSync(abs, { throwIfNoEntry: false })?.size ?? 0) : 0
      const item: PlanItem = {
        path: c.path,
        disposition: 'selected',
        bytes,
        addedLines: c.added.size,
        language: packFor(c.path)?.name ?? (TS.test(c.path) ? 'typescript' : 'other'),
        checks: [],
      }

      if (!abs || isSymlink(abs)) {
        item.disposition = 'failed'
        item.reason = 'outside the repository, or a link that leaves it'
      } else if (matchesAny(c.path, config.ignore)) {
        item.disposition = 'waived'
        item.reason = 'ignored by config'
      } else if (bytes > MAX_FILE_BYTES) {
        item.disposition = 'waived'
        item.reason = 'over ' + Math.round(MAX_FILE_BYTES / 1024) + 'KB — generated or minified, not written'
      }
      rows.set(c.path, item)
    }
    return new SelectionPlan(rows)
  }

  /** A policy decision: it was not reviewed, and that is the intended outcome. */
  waive(path: string, reason: string): void {
    const row = this.rows.get(path)
    if (row && row.disposition === 'selected') {
      row.disposition = 'waived'
      row.reason = reason
    }
  }

  /** Reviewed, but with less than the run's full check set. */
  limit(path: string, missing: Capability[]): void {
    const row = this.rows.get(path)
    if (row && row.disposition === 'selected' && missing.length > 0) {
      row.missing = [...new Set([...(row.missing ?? []), ...missing])]
    }
  }

  /** Record optional semantic depth that this environment could not provide. */
  noteUnavailable(path: string, unavailable: Capability[]): void {
    const row = this.rows.get(path)
    if (row && row.disposition === 'selected' && unavailable.length > 0) {
      row.unavailable = [...new Set([...(row.unavailable ?? []), ...unavailable])]
    }
  }

  /** Record coverage at the same file granularity used to decide applicability. */
  checked(path: string, check: string): void {
    const row = this.rows.get(path)
    if (row && row.disposition === 'selected') {
      row.checks = [...new Set([...row.checks, check])]
    }
  }

  /** We meant to review it and could not. This is what makes a run incomplete. */
  fail(path: string, reason: string): void {
    const row = this.rows.get(path)
    if (row) {
      row.disposition = 'failed'
      row.reason = reason
    }
  }

  keep(changed: ChangedFile[]): ChangedFile[] {
    return changed.filter((c) => this.rows.get(c.path)?.disposition === 'selected')
  }

  /**
   * Finish the file-level selection after parsers have had one chance to load it.
   *
   * Review and delegation both promise to describe the same change. Keeping this
   * transition on the plan prevents either caller from silently inventing its own
   * meaning for a deleted, unsupported, or unavailable source file.
   */
  accountForGround(changed: ChangedFile[], ground: Ground): void {
    const grounded = new Set([
      ...ground.files.map((file) => file.changed.path),
      ...ground.foreign.map((file) => file.path),
    ])
    for (const file of changed) {
      if (file.deleted) {
        this.waive(file.path, 'deleted file has no current source to review')
        continue
      }
      if (grounded.has(file.path)) continue
      if (packFor(file.path)) this.fail(file.path, 'declared language parser unavailable')
      else this.waive(file.path, 'no parser for this language')
    }
  }

  items(): PlanItem[] {
    return [...this.rows.values()]
  }

  of(disposition: Disposition): PlanItem[] {
    return this.items().filter((i) => i.disposition === disposition)
  }

  /** What a reader should be told about, grouped so one line covers many files. */
  summary(): string[] {
    const byReason = new Map<string, number>()
    for (const i of this.items()) {
      if (i.disposition === 'selected') continue
      const key = i.disposition + ': ' + (i.reason ?? 'unknown')
      byReason.set(key, (byReason.get(key) ?? 0) + 1)
    }
    const limited = this.items().filter((i) => i.disposition === 'selected' && i.missing?.length)
    const out = [...byReason].map(([reason, n]) => n + ' file(s) ' + reason)
    if (limited.length > 0) {
      out.push(limited.length + ' file(s) reviewed without ' + [...new Set(limited.flatMap((i) => i.missing!))].join(', '))
    }
    return out
  }
}

/**
 * What the ground can actually answer, which is not always what was asked for.
 *
 * A repository with no tsconfig has no member resolution and no reference graph; a
 * scan has no base version to compare against. Working this out once, here, is what
 * lets a check declare `needs` instead of each one rediscovering it.
 */
export function capabilitiesOf(g: Ground): Set<Capability> {
  const caps = new Set<Capability>(['syntax'])
  if (g.typed) {
    caps.add('types')
    caps.add('references')
  }
  // Kept apart from `types` on purpose. A repository with a tsconfig and some Python
  // in it would otherwise satisfy the Python check through the TypeScript checker,
  // and the check would be recorded as run and satisfied with no oracle behind it.
  if (g.foreign.some((f) => f.pack.name === 'python') && pyrightAvailable(g.root)) {
    caps.add('python-types')
  }
  if (g.changed.some((c) => c.before !== undefined)) caps.add('base')
  return caps
}
