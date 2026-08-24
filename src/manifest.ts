import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Usage } from './budget.js'
import type { PlanItem } from './plan.js'
import type { Severity } from './types.js'

export const SCHEMA = 'powershot.run/v1' as const

/** What became of one unit of judging work. Exactly one of these, always. */
export type UnitOutcome = 'completed' | 'reused' | 'failed' | 'waived'

export type UnitRecord = {
  judge: string
  unit: string
  outcome: UnitOutcome
  /** why, for anything that is not `completed` */
  reason?: string
  findings: number
}

export type RunManifestV1 = {
  schema: typeof SCHEMA
  id: string
  operation: string
  started: string
  ended: string
  repository: { head?: string }
  /** what was asked for, and what those names resolved to */
  target: { requested: Record<string, string | undefined>; base?: string; head?: string }
  /** which policy judged this run, and its exact bytes */
  policy: { source: 'base' | 'head' | 'default'; ref?: string; hash: string }
  engine: {
    version: string
    provider?: string
    model?: string
    tools: boolean
    verifyOnly: boolean
    /** Effective reporting threshold after config and CLI overrides. */
    minSeverity?: Severity
  }
  files: PlanItem[]
  units: UnitRecord[]
  checks: {
    ran: string[]
    skipped: { check: string; missing: string }[]
    /** Enriched checks not promised by portable coverage. */
    unavailable?: { check: string; missing: string }[]
  }
  /** `full` means every applicable configured oracle was available. */
  coverage?: 'full' | 'portable'
  findings: { total: number; verified: number; judged: number; dismissed: number; droppedPosition: number }
  usage: Usage
  /**
   * `complete` — every selected file and unit reached a terminal outcome we meant.
   * `partial` — an oracle, budget or cancellation limited it, and the gap is named.
   * `failed`  — a stage we needed did not run, so this is not a verdict at all.
   */
  state: 'complete' | 'partial' | 'failed'
  failures: string[]
  /** everything that makes this less than a full review, in one readable list */
  notLookedAt: string[]
}

export type Completion = Pick<RunManifestV1, 'state' | 'notLookedAt'>
export type CompletionParts = {
  files: PlanItem[]
  units: UnitRecord[]
  skippedChecks: { check: string; missing: string }[]
  failures: string[]
  cancelled?: boolean
  budgetStop?: string
}

/** The single state machine behind manifests, benches, renderers and exit codes. */
export function completionOf(parts: CompletionParts): Completion {
  const waivedUnits = parts.units.filter((unit) => unit.outcome === 'waived').length
  const failedUnits = parts.units.filter((unit) => unit.outcome === 'failed').length
  const failedFiles = parts.files.filter((file) => file.disposition === 'failed').length
  const limitedFiles = parts.files.filter(
    (file) => file.disposition === 'selected' && file.missing?.length,
  ).length

  const state: RunManifestV1['state'] =
    parts.failures.length > 0 || failedUnits > 0 || failedFiles > 0
      ? 'failed'
      : parts.cancelled || parts.budgetStop || waivedUnits > 0 || limitedFiles > 0 || parts.skippedChecks.length > 0
        ? 'partial'
        : 'complete'

  return {
    state,
    notLookedAt: reasons(
      parts.files,
      parts.units,
      parts.skippedChecks,
      parts.failures,
      parts.cancelled,
      parts.budgetStop,
    ),
  }
}

/**
 * The one authoritative record of a run.
 *
 * Every renderer, exit code, session and approval decision should read this rather
 * than re-derive its own idea of what happened. The point is not bookkeeping: a run
 * that turned files away, skipped checks it could not supply, or stopped on a budget
 * still produces a findings list, and a findings list on its own cannot tell a reader
 * which of those it is. `selected = completed ∪ reused ∪ failed ∪ waived` is the
 * invariant that makes "no findings" mean something.
 */
export class RunManifest {
  private readonly units: UnitRecord[] = []
  private readonly ranChecks: string[] = []
  private readonly startedAt = new Date().toISOString()

  constructor(private readonly id: string) {}

  unit(record: UnitRecord): void {
    this.units.push(record)
  }

  ran(check: string): void {
    this.ranChecks.push(check)
  }

  build(parts: {
    operation: string
    repositoryHead?: string
    target: RunManifestV1['target']
    policy: RunManifestV1['policy']
    engine: RunManifestV1['engine']
    files: PlanItem[]
    skippedChecks: { check: string; missing: string }[]
    unavailableChecks?: { check: string; missing: string }[]
    findings: RunManifestV1['findings']
    usage: Usage
    failures: string[]
    cancelled?: boolean
    budgetStop?: string
  }): RunManifestV1 {
    const completion = completionOf({
      files: parts.files,
      units: this.units,
      skippedChecks: parts.skippedChecks,
      failures: parts.failures,
      cancelled: parts.cancelled,
      budgetStop: parts.budgetStop,
    })

    return {
      schema: SCHEMA,
      id: this.id,
      operation: parts.operation,
      started: this.startedAt,
      ended: new Date().toISOString(),
      repository: { head: parts.repositoryHead },
      target: parts.target,
      policy: parts.policy,
      engine: parts.engine,
      files: parts.files.map((file) => ({
        ...file,
        checks: [...file.checks],
        missing: file.missing ? [...file.missing] : undefined,
        unavailable: file.unavailable ? [...file.unavailable] : undefined,
      })),
      units: this.units.map((unit) => ({ ...unit })),
      checks: {
        ran: [...this.ranChecks],
        skipped: parts.skippedChecks.map((check) => ({ ...check })),
        ...((parts.unavailableChecks?.length ?? 0) > 0
          ? { unavailable: parts.unavailableChecks!.map((check) => ({ ...check })) }
          : {}),
      },
      coverage: parts.files.some((file) => file.missing?.length || file.unavailable?.length) ||
        parts.skippedChecks.length > 0 || (parts.unavailableChecks?.length ?? 0) > 0
        ? 'portable'
        : 'full',
      findings: { ...parts.findings },
      usage: { ...parts.usage },
      state: completion.state,
      failures: [...parts.failures],
      notLookedAt: [...completion.notLookedAt],
    }
  }
}

/** Why this run is less than a full review, said once in words a reader can act on. */
function reasons(
  files: PlanItem[],
  units: UnitRecord[],
  skipped: { check: string; missing: string }[],
  failures: string[],
  cancelled?: boolean,
  budgetStop?: string,
): string[] {
  const out = [...failures]
  if (cancelled) out.push('cancelled before every unit was judged')
  if (budgetStop) out.push('stopped early: ' + budgetStop)

  const group = (items: string[], label: (n: number) => string): void => {
    if (items.length > 0) out.push(label(items.length) + ': ' + items.slice(0, 5).join(', ') + (items.length > 5 ? ', …' : ''))
  }
  group(files.filter((f) => f.disposition === 'failed').map((f) => f.path), (n) => n + ' file(s) could not be read')
  group(
    files.filter((f) => f.disposition === 'selected' && f.missing?.length).map((f) => f.path + ' (no ' + f.missing!.join(', ') + ')'),
    (n) => n + ' file(s) reviewed with fewer checks than the rest',
  )
  group(units.filter((u) => u.outcome === 'failed' || u.outcome === 'waived').map((u) => u.judge + ' · ' + u.unit),
    (n) => n + ' judge unit(s) never answered')
  group(skipped.map((s) => s.check + ' (no ' + s.missing + ')'), (n) => n + ' check(s) had no oracle to run against')
  return [...new Set(out)]
}

/**
 * The coverage contract, checked rather than asserted in prose.
 *
 * Returns what is wrong, empty when the manifest accounts for everything it selected.
 * A manifest that fails this is a bug in PowerShot, not a finding about the code.
 */
export function coverageProblems(m: RunManifestV1): string[] {
  const problems: string[] = []
  const dispositions = new Set(['selected', 'waived', 'failed'])
  const checksByFile = new Set<string>()
  for (const f of m.files) {
    if (!dispositions.has(f.disposition)) problems.push(f.path + ': unknown disposition ' + f.disposition)
    if (f.disposition !== 'selected' && !f.reason) problems.push(f.path + ': ' + f.disposition + ' without a reason')
    if (!Array.isArray(f.checks)) {
      problems.push(f.path + ': missing per-file checks')
      continue
    }
    if (f.disposition !== 'selected' && f.checks.length > 0) {
      problems.push(f.path + ': ' + f.disposition + ' file received checks')
    }
    if (f.disposition !== 'selected' && f.unavailable?.length) {
      problems.push(f.path + ': ' + f.disposition + ' file has unavailable coverage')
    }
    const missingCaps = new Set(f.missing ?? [])
    for (const capability of f.unavailable ?? []) {
      if (missingCaps.has(capability)) {
        problems.push(f.path + ': capability is both required and unavailable: ' + capability)
      }
    }
    const local = new Set<string>()
    for (const check of f.checks) {
      if (local.has(check)) problems.push(f.path + ': received check twice: ' + check)
      local.add(check)
      checksByFile.add(check)
    }
  }

  const seen = new Set<string>()
  for (const u of m.units) {
    const key = u.judge + '|' + u.unit
    if (seen.has(key)) problems.push('unit counted twice: ' + key)
    seen.add(key)
    if (u.outcome !== 'completed' && !u.reason) problems.push(key + ': ' + u.outcome + ' without a reason')
  }

  const ran = new Set<string>()
  for (const check of m.checks.ran) {
    if (ran.has(check)) problems.push('check counted twice as ran: ' + check)
    ran.add(check)
  }
  for (const check of checksByFile) {
    if (!ran.has(check)) problems.push('file received a check not recorded as ran: ' + check)
  }
  for (const check of ran) {
    if (!checksByFile.has(check)) problems.push('ran check received no selected file: ' + check)
  }
  const skipped = new Set<string>()
  for (const check of m.checks.skipped) {
    if (skipped.has(check.check)) problems.push('check counted twice as skipped: ' + check.check)
    skipped.add(check.check)
    if (ran.has(check.check)) problems.push('check counted as both ran and skipped: ' + check.check)
  }
  const unavailable = new Set<string>()
  for (const check of m.checks.unavailable ?? []) {
    if (unavailable.has(check.check)) problems.push('check counted twice as unavailable: ' + check.check)
    unavailable.add(check.check)
    if (skipped.has(check.check)) problems.push('check counted as both skipped and unavailable: ' + check.check)
  }

  const expectedCoverage = m.files.some((file) => file.missing?.length || file.unavailable?.length) ||
    m.checks.skipped.length > 0 || (m.checks.unavailable?.length ?? 0) > 0
    ? 'portable'
    : 'full'
  if (m.coverage !== undefined && m.coverage !== expectedCoverage) {
    problems.push('coverage is ' + m.coverage + ' but accounting says ' + expectedCoverage)
  }

  // a judged run that reports complete must have reached every unit it selected
  const unreached = m.units.filter((u) => u.outcome === 'failed' || u.outcome === 'waived')
  if (m.state === 'complete' && unreached.length > 0) {
    problems.push('state is complete but ' + unreached.length + ' unit(s) were never judged')
  }
  if (m.state === 'complete' && m.files.some((f) => f.disposition === 'failed')) {
    problems.push('state is complete but a file failed selection')
  }
  const limited = m.files.filter((f) => f.disposition === 'selected' && f.missing?.length)
  if (m.state === 'complete' && limited.length > 0) {
    problems.push('state is complete but ' + limited.length + ' file(s) were reviewed with fewer checks')
  }
  if (m.state === 'complete' && m.checks.skipped.length > 0) {
    problems.push('state is complete but ' + m.checks.skipped.length + ' check(s) had no oracle')
  }
  if (m.state === 'complete' && m.notLookedAt.length > 0) {
    problems.push('state is complete but notLookedAt is not empty')
  }
  if (m.state === 'complete' && m.failures.length > 0) {
    problems.push('state is complete but failures are not empty')
  }
  if (m.state !== 'complete' && m.notLookedAt.length === 0) {
    problems.push('state is ' + m.state + ' but notLookedAt is empty')
  }
  return problems
}

/** Manifests hold paths and reasons from the reviewed tree; keep the last few. */
const KEEP = 100

export function writeManifest(root: string, m: RunManifestV1): string {
  const dir = join(root, '.powershot', 'runs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    const old = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => a.at - b.at)
    for (const { name } of old.slice(0, Math.max(0, old.length - KEEP + 1))) rmSync(join(dir, name), { force: true })
  } catch {
    // housekeeping must never be the reason a finished review fails to record itself
  }
  const file = join(dir, m.id + '.json')
  writeFileSync(file, JSON.stringify(m, null, 2), { mode: 0o600 })
  return file
}

export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
