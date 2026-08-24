import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Finding } from './types.js'

const DIR = '.powershot/sessions'

/**
 * How many runs to keep. Sessions hold source frames, so an unbounded directory grows
 * with the repository it is reviewing and nothing ever removes it.
 */
const KEEP = 50

function prune(dir: string): void {
  try {
    // ids are hashes, so the filename says nothing about age — the clock does
    const files = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => a.at - b.at)
    for (const { name } of files.slice(0, Math.max(0, files.length - KEEP + 1))) {
      rmSync(join(dir, name), { force: true })
    }
  } catch {
    // housekeeping must never be the reason a review does not start
  }
}

type Stored = {
  id: string
  started: string
  target: string
  /** who answered. Resuming under a different one would mix two reviews into one. */
  asked?: { provider: string; model: string }
  /** judge results keyed by `judge|unit`, so a resumed run pays only for what is left */
  done: Record<string, Finding[]>
  /** the finished review, including whether its findings are a complete verdict */
  report?: {
    findings: Finding[]
    verified: number
    judged: number
    state?: 'complete' | 'partial' | 'failed'
    notLookedAt?: string[]
    coverage?: 'full' | 'portable'
    unavailableCoverage?: string[]
  }
}

/** Only judge results are kept: the deterministic half is free and re-runs, which
 *  keeps a resumed review honest about the current state of the files. */
export class Session {
  private constructor(
    private readonly file: string,
    private readonly data: Stored,
  ) {}

  static create(root: string, target: string, asked?: { provider: string; model: string }): Session {
    const id = createHash('sha1').update(target + ':' + Date.now()).digest('hex').slice(0, 8)
    const dir = join(root, DIR)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    prune(dir)
    return new Session(join(dir, id + '.json'), {
      id,
      started: new Date().toISOString(),
      target,
      asked,
      done: {},
    })
  }

  /** Whether this session's answers came from who is being asked now. */
  askedBy(provider: string, model: string): boolean {
    if (!this.data.asked) return true // recorded before this was stored; nothing to check
    return this.data.asked.provider === provider && this.data.asked.model === model
  }

  get asked(): { provider: string; model: string } | undefined {
    return this.data.asked
  }

  static open(root: string, id: string): Session | undefined {
    const file = join(root, DIR, id + '.json')
    if (!existsSync(file)) return undefined
    try {
      return new Session(file, JSON.parse(readFileSync(file, 'utf8')) as Stored)
    } catch {
      return undefined // a corrupt session is not worth failing a review over
    }
  }

  static list(root: string): { id: string; started: string; target: string; done: number }[] {
    const dir = join(root, DIR)
    if (!existsSync(dir)) return []
    const out: { id: string; started: string; target: string; done: number }[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const d = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Stored
        out.push({ id: d.id, started: d.started, target: d.target, done: Object.keys(d.done).length })
      } catch {
        // skip anything unreadable rather than refusing to list the rest
      }
    }
    return out.sort((a, b) => b.started.localeCompare(a.started))
  }

  get id(): string {
    return this.data.id
  }

  /**
   * The content fingerprint distinguishes an edited bundle from the old question;
   * hashing also keeps path-derived keys bounded and stable.
   */
  private static key(judge: string, unit: string, fingerprint: string): string {
    return judge + '|' + createHash('sha1').update(unit + '\0' + fingerprint).digest('hex').slice(0, 20)
  }

  get(judge: string, unit: string, fingerprint: string): Finding[] | undefined {
    return this.data.done[Session.key(judge, unit, fingerprint)]
  }

  record(judge: string, unit: string, fingerprint: string, findings: Finding[]): void {
    this.data.done[Session.key(judge, unit, fingerprint)] = findings
    this.save()
  }

  saveReport(
    findings: Finding[],
    verdict: {
      state: 'complete' | 'partial' | 'failed'
      notLookedAt: string[]
      coverage?: 'full' | 'portable'
      unavailableCoverage?: string[]
    },
  ): void {
    this.data.report = {
      findings,
      verified: findings.filter((f) => f.class === 'verified').length,
      judged: findings.filter((f) => f.class === 'judged').length,
      state: verdict.state,
      notLookedAt: verdict.notLookedAt,
      coverage: verdict.coverage,
      unavailableCoverage: verdict.unavailableCoverage,
    }
    this.save()
  }

  get report(): Stored['report'] {
    return this.data.report
  }

  get target(): string {
    return this.data.target
  }

  get started(): string {
    return this.data.started
  }

  /** What moved between two reviews. */
  static compare(before: Session, after: Session): { fixed: Finding[]; introduced: Finding[]; remaining: Finding[] } {
    if (before.report?.state !== 'complete' || after.report?.state !== 'complete') {
      throw new Error('only complete review sessions can be compared')
    }
    const key = (f: Finding): string => f.check + '|' + f.file + '|' + f.title
    const was = new Map((before.report?.findings ?? []).map((f) => [key(f), f]))
    const is = new Map((after.report?.findings ?? []).map((f) => [key(f), f]))

    return {
      fixed: [...was].filter(([k]) => !is.has(k)).map(([, f]) => f),
      introduced: [...is].filter(([k]) => !was.has(k)).map(([, f]) => f),
      remaining: [...is].filter(([k]) => was.has(k)).map(([, f]) => f),
    }
  }

  private save(): void {
    // written after every unit, so an interrupted run keeps everything already paid for
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }
}
