import { buildGround } from './ground.js'
import type { Capability, ForeignFile, Ground, Verifier } from './types.js'
import { baseRefOf, collectChanges, statedIntent, type Range } from './git.js'
import { bundle, bundleName, reviewables, uncovered } from './bundle.js'
import { attachFrames, positionable } from './position.js'
import type { Session } from './session.js'
import { JudgeCache } from './cache.js'
import { Dismissals, rememberReport } from './dismissed.js'
import { renderChanges } from './judges/judge.js'
import { VERIFIERS } from './verifiers/index.js'
import { runJudge } from './judges/judge.js'
import { COMMON, JUDGES } from './judges/prompts.js'
import { apiKey } from './judges/llm.js'
import { enabled, type Config } from './config.js'
import { SelectionPlan, capabilitiesOf } from './plan.js'
import { Budget, type Usage } from './budget.js'
import type { RunManifest } from './manifest.js'
import { packFor } from './lang/packs.js'
import { SEVERITIES, type ChangedFile, type Finding, type Severity } from './types.js'
import { lines as splitLines, stripControl, stripPath } from './text.js'

export type ReviewOptions = {
  /** the tree whose files are analysed — a snapshot of the target ref, or the repo */
  root: string
  /** where git history and `.powershot` live, when `root` is a throwaway checkout */
  stateRoot?: string
  range: Range
  config: Config
  verifyOnly: boolean
  checks?: string[]
  onProgress?: (line: string) => void
  onStage?: (label: string) => (result: string) => void
  /** for `scan`, where there is no diff to read */
  changes?: ChangedFile[]
  maxBundleLines?: number
  tools?: boolean
  session?: Session
  /** aborts before the next unit; work already paid for is kept */
  signal?: AbortSignal
  onCancelable?: (active: boolean) => void
  cache?: boolean
  showDismissed?: boolean
  /** From a delegated agent. Merged here so they meet the same invariants. */
  absorbed?: Finding[]
  /** what this run may spend before it stops and reports what it did not reach */
  budget?: Budget
  /** collects the one authoritative record of what happened */
  manifest?: RunManifest
}

export type ReviewResult = {
  findings: Finding[]
  stats: { files: number; verified: number; judged: number; dismissed: number }
  /** every file the change touched and what became of it */
  plan?: SelectionPlan
  /** checks that were asked for and could not run, with what was missing */
  skippedChecks?: { check: string; missing: string }[]
  /** enriched checks unavailable under portable coverage */
  unavailableChecks?: { check: string; missing: string }[]
  usage?: Usage
  /** set when a limit stopped the run before it reached every unit */
  budgetStop?: string
  cancelled?: boolean
  droppedPosition?: number
  /** "no findings" and "we could not look" must not be the same answer. */
  failures: string[]
}

export function atLeast(severity: Severity, min: Severity): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(min)
}

/** How much two titles say the same thing, as a share of the words they use. */
export function titleOverlap(a: string, b: string): number {
  const words = (t: string): Set<string> =>
    new Set(t.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const w of left) if (right.has(w)) shared++
  return shared / Math.min(left.size, right.size)
}

type NativeFile = Ground['files'][number]
type VerifierTarget =
  | { kind: 'typescript'; path: string; file: NativeFile; missing: Capability[] }
  | { kind: 'foreign'; path: string; file: ForeignFile; missing: Capability[] }

const PORTABLE_OPTIONAL = new Set<Capability>(['types', 'references', 'python-types'])

/**
 * Files this verifier can actually answer for, with unavailable oracles kept per
 * file. A before/after check has no question to ask about a newly created file;
 * when an existing file has a base snapshot that cannot be parsed, `base` is a real
 * missing capability and remains verdict-blocking in every coverage profile.
 */
function verifierTargets(v: Verifier, g: Ground, have: Set<Capability>): VerifierTarget[] {
  if (v.domain === 'typescript') {
    return g.files
      .filter((file) => !v.needs.includes('base') || file.changed.before !== undefined)
      .map((file) => ({
        kind: 'typescript' as const,
        path: file.changed.path,
        file,
        missing: v.needs.filter((need) => {
          if (need === 'base') return file.before === undefined
          if (need === 'types' || need === 'references') return !file.typed
          if (need === 'python-types') return true
          return false
        }),
      }))
  }

  if (v.domain === 'foreign' || v.domain === 'python') {
    return g.foreign
      .filter((file) => v.domain !== 'python' || file.pack.name === 'python')
      .filter((file) => !v.supports || v.supports(file))
      .filter((file) => !v.needs.includes('base') || file.changed.before !== undefined)
      .map((file) => ({
        kind: 'foreign' as const,
        path: file.path,
        file,
        missing: v.needs.filter((need) => {
          if (need === 'base') return file.beforeTree === undefined
          if (need === 'python-types') return file.pack.name !== 'python' || !have.has('python-types')
          if (need === 'types' || need === 'references') return true
          return false
        }),
      }))
  }

  return []
}

function groundFor(g: Ground, targets: VerifierTarget[]): Ground {
  const files = targets
    .filter((target): target is Extract<VerifierTarget, { kind: 'typescript' }> =>
      target.kind === 'typescript' && target.missing.length === 0,
    )
    .map((target) => target.file)
  const foreign = targets
    .filter((target): target is Extract<VerifierTarget, { kind: 'foreign' }> =>
      target.kind === 'foreign' && target.missing.length === 0,
    )
    .map((target) => target.file)
  return { ...g, files, foreign, typed: files.some((file) => file.typed) }
}

function dropNearDuplicates(findings: Finding[]): Finding[] {
  const kept: Finding[] = []
  for (const f of findings) {
    const duplicate = kept.some(
      (k) => k.file === f.file && Math.abs(k.line - f.line) <= 2 && titleOverlap(k.title, f.title) >= 0.7,
    )
    if (!duplicate) kept.push(f)
  }
  return kept
}

function finalize(findings: Finding[]): Finding[] {
  // the compiler reports one mistake through several diagnostics
  const seen = new Set<string>()
  findings = findings.filter((f) => {
    const k = f.check + '|' + f.file + '|' + f.line + '|' + f.title
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // Sorted before folding: folding keeps whichever copy comes first, so the other
  // way round a `low` duplicate would evict the `critical` saying the same thing.
  const sorted = findings.slice().sort((a, b) => {
    if (a.class !== b.class) return a.class === 'verified' ? -1 : 1
    const sev = SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity)
    if (sev !== 0) return sev
    return a.file.localeCompare(b.file) || a.line - b.line
  })

  // Sanitized once here rather than per renderer: a title or a frame line is
  // attacker-controlled text, and every output path prints it somewhere
  return dropNearDuplicates(sorted).map((f, i) => ({
    ...f,
    id: 'F' + (i + 1),
    file: stripPath(f.file),
    title: stripControl(f.title),
    fix: f.fix === undefined ? undefined : stripControl(f.fix),
    suggestion: f.suggestion === undefined ? undefined : stripControl(f.suggestion),
    evidence: f.evidence && { oracle: stripControl(f.evidence.oracle), detail: stripControl(f.evidence.detail) },
    frame: f.frame && { ...f.frame, lines: f.frame.lines.map(stripControl) },
  }))
}

export async function review(opts: ReviewOptions): Promise<ReviewResult> {
  const { root, range, config, verifyOnly, onProgress } = opts
  const repo = opts.stateRoot ?? root
  const say = onProgress ?? (() => {})
  const stage = opts.onStage ?? (() => () => {})

  const failures: string[] = []
  let budgetStop: string | undefined
  const all = opts.changes ?? collectChanges(repo, range)
  const plan = SelectionPlan.build(root, all, config)
  const changed = plan.keep(all)
  if (changed.length === 0) {
    for (const line of plan.summary()) say('selection ' + line)
    return { findings: [], stats: { files: 0, verified: 0, judged: 0, dismissed: 0 }, failures, plan }
  }

  const skipped = new Map<string, string>()
  const unavailable = new Map<string, string>()
  const budget = opts.budget ?? new Budget()
  const manifest = opts.manifest
  const groundDone = stage('ground')
  const g = await buildGround(root, changed, opts.signal)
  groundDone(
    g.sourceFiles.length + ' files · ' + g.symbolIndex.size + ' symbols' +
      (g.configFiles.length === 0
        ? ' · no usable relevant tsconfig, type checks disabled'
        : ' · ' + g.configFiles.length + ' project(s)' + (g.typed ? '' : ' · type environment incomplete')),
  )

  const wanted = (v: Verifier): boolean => {
    const id = v.id ?? v.name
    return opts.checks
      ? opts.checks.includes(id) || opts.checks.includes(v.name)
      : enabled(config.verifiers, id) || enabled(config.verifiers, v.name)
  }
  const have = capabilitiesOf(g)
  const targets = new Map<Verifier, VerifierTarget[]>()
  for (const verifier of VERIFIERS) {
    if (!wanted(verifier)) continue
    const files = verifierTargets(verifier, g, have)
    if (files.length > 0) targets.set(verifier, files)
  }
  const selectedVerifiers = [...targets.keys()]
  // Naming a check explicitly is a request for that oracle, even under the portable
  // default. Strict policy makes the same promise for every configured verifier.
  const requireEnrichedOracles = config.coverage === 'strict' || opts.checks !== undefined

  // a file the change touched that no parser produced a tree for was not reviewed,
  // whatever the summary says about the ones that were
  const grounded = new Set([...g.files.map((f) => f.changed.path), ...g.foreign.map((f) => f.path)])
  for (const c of changed) {
    if (grounded.has(c.path)) continue
    if (packFor(c.path)) plan.fail(c.path, 'declared language parser unavailable')
    else plan.waive(c.path, 'no parser for this language')
  }
  // Capabilities belong to files, not runs. A typed file beside one excluded from
  // tsconfig must not make the latter look checked, and an old Ruby file must not
  // make a new Python file eligible for a before/after oracle.
  for (const files of targets.values()) {
    for (const file of files) {
      const required = file.missing.filter((capability) => !PORTABLE_OPTIONAL.has(capability))
      const enriched = file.missing.filter((capability) => PORTABLE_OPTIONAL.has(capability))
      plan.limit(file.path, required)
      if (requireEnrichedOracles) plan.limit(file.path, enriched)
      else plan.noteUnavailable(file.path, enriched)
    }
  }
  for (const line of plan.summary()) say('selection ' + line)
  for (const f of plan.of('failed')) failures.push('not reviewed: ' + f.path + ' — ' + f.reason)

  const verifyDone = stage('verify')
  const findings: Finding[] = []
  let ran = 0
  for (const v of selectedVerifiers) {
    // a check that cannot run must say so rather than return nothing, which reads
    // exactly like a check that ran and was satisfied
    const files = targets.get(v)!
    const eligible = files.filter((file) => file.missing.length === 0)
    const missing = [...new Set(files.flatMap((file) => file.missing))]
    const check = v.id ?? v.name
    const onlyEnrichedMissing = missing.every((capability) => PORTABLE_OPTIONAL.has(capability))
    if (missing.length > 0 && !requireEnrichedOracles && onlyEnrichedMissing) {
      unavailable.set(check, missing.join(', '))
    }
    if (missing.length > 0 && eligible.length === 0) {
      if (requireEnrichedOracles || !onlyEnrichedMissing) skipped.set(check, missing.join(', '))
      continue
    }
    // a scan spends most of its time here, so Ctrl-C has to reach this half
    if (opts.signal?.aborted) {
      failures.push('cancelled during verification')
      break
    }
    ran++
    manifest?.ran(check)
    for (const file of eligible) plan.checked(file.path, check)
    try {
      findings.push(...v.run(groundFor(g, files)))
    } catch (e) {
      failures.push(v.name + ': ' + (e as Error).message)
    }
  }
  verifyDone(ran + ' checks × ' + reviewables(g).length + ' files · 0 tokens')
  if (skipped.size > 0) {
    const names = [...skipped].map(([n, why]) => n + ' (no ' + why + ')')
    say('skipped   ' + names.join(', '))
  }
  if (unavailable.size > 0) {
    const names = [...unavailable].map(([n, why]) => n + ' (no ' + why + ')')
    say('coverage  portable · enriched checks unavailable: ' + names.join(', '))
  }

  // --checks overrides the config rather than filtering it
  const isGated = range.from !== undefined || range.commit !== undefined
  const judgeCache = opts.cache === false || verifyOnly ? undefined : JudgeCache.open(repo, isGated)

  const wantedJudges = JUDGES.filter((j) =>
    opts.checks ? opts.checks.includes(j.name) : enabled(config.judges, j.name),
  )

  if (!verifyOnly && wantedJudges.length > 0) {
    if (!apiKey(config)) {
      // requested and not run is not the same as not requested: a run that was asked
      // for judges and never reached one must not report the deterministic half as
      // the whole answer
      failures.push('judges requested but no API key set: ' + wantedJudges.map((j) => j.name).join(', '))
      say('judge     skipped — no API key set (use --verify-only to silence this)')
    } else {
      opts.onCancelable?.(true)
      const intent = statedIntent(repo, range)
      const units = bundle(g, opts.maxBundleLines ?? 1200)
      let cancelled = false
      if (units.length > 1) {
        say('bundle    ' + reviewables(g).length + ' files → ' + units.length + ' review units')
      }
      const missed = uncovered(g, units)
      if (missed.length > 0) failures.push('not sent to any judge: ' + missed.slice(0, 5).join(', '))

      for (const spec of wantedJudges) {
        if (cancelled) break
        for (const unit of units) {
          // between units, not mid-flight: `--resume` picks up exactly here
          if (opts.signal?.aborted) {
            cancelled = true
            failures.push('cancelled before ' + spec.name + ' finished')
            manifest?.unit({ judge: spec.name, unit: bundleName(unit, root), outcome: 'waived', reason: 'cancelled', findings: 0 })
            break
          }
          const stop = budget.exhausted()
          if (stop) {
            budgetStop = stop
            manifest?.unit({ judge: spec.name, unit: bundleName(unit, root), outcome: 'waived', reason: stop, findings: 0 })
            continue
          }
          const label = units.length > 1 ? spec.name + ' · ' + bundleName(unit, root) : spec.name
          const rendered = renderChanges(unit.files)
          const cached = opts.session?.get(spec.name, bundleName(unit, root), rendered)
          if (cached) {
            findings.push(...cached)
            manifest?.unit({ judge: spec.name, unit: bundleName(unit, root), outcome: 'reused', reason: 'resumed from session', findings: cached.length })
            say('judge     ' + label + ' → ' + cached.length + ' findings (resumed)')
            continue
          }

          const key = JudgeCache.key({
            judge: spec.name,
            provider: config.provider,
            model: config.model,
            prompt: COMMON + '\n' + spec.brief,
            tools: opts.tools ?? false,
            content: rendered,
            intent: spec.needsIntent ? intent : undefined,
          })
          const remembered = judgeCache?.get(key)
          if (remembered) {
            findings.push(...remembered)
            opts.session?.record(spec.name, bundleName(unit, root), rendered, remembered)
            manifest?.unit({ judge: spec.name, unit: bundleName(unit, root), outcome: 'reused', reason: 'answered before, same question', findings: remembered.length })
            say('judge     ' + label + ' → ' + remembered.length + ' findings (cached)')
            continue
          }

          const judgeDone = stage('judge')
          try {
            const judged = await runJudge(spec, g, config, { intent, bundle: unit, useTools: opts.tools, budget })
            findings.push(...judged)
            opts.session?.record(spec.name, bundleName(unit, root), rendered, judged)
            judgeCache?.put(key, judged, new Date().toISOString())
            manifest?.unit({ judge: spec.name, unit: bundleName(unit, root), outcome: 'completed', findings: judged.length })
            judgeDone(label + ' → ' + judged.length + ' findings')
          } catch (e) {
            // keep what the others found, but the run is incomplete from here
            const detail = label + ': ' + (e as Error).message
            failures.push(detail)
            manifest?.unit({ judge: spec.name, unit: bundleName(unit, root), outcome: 'failed', reason: (e as Error).message, findings: 0 })
            judgeDone(label + ' failed: ' + (e as Error).message)
          }
        }
      }
    }
  }

  judgeCache?.save()
  opts.onCancelable?.(false)

  if (opts.absorbed?.length) findings.push(...opts.absorbed)

  const positioned = positionable(findings, g)
  if (positioned.dropped > 0) {
    say('position  dropped ' + positioned.dropped + ' judged finding(s) pointing outside the change')
  }

  const framed = attachFrames(positioned.kept, g).filter((f) => atLeast(f.severity, config.minSeverity))

  // the count is still reported: a filter nobody can see is one nobody can trust
  const gated = range.from !== undefined || range.commit !== undefined
  const base = gated ? baseRefOf(repo, range) : undefined
  const dismissals = Dismissals.open(repo, base)
  const surviving = opts.showDismissed ? framed : framed.filter((f) => !dismissals.has(f))
  const dismissed = framed.length - surviving.length
  if (dismissed > 0 && !opts.showDismissed) {
    say('dismissed ' + dismissed + ' finding(s) previously called correct — psh dismiss list')
  }
  const pending = base ? Dismissals.pendingIn(repo, base) : 0
  if (pending > 0) say('dismissed ' + pending + ' new dismissal(s) in this change — not applied to it')

  const kept = finalize(surviving)
  rememberReport(repo, kept) // so `psh dismiss F2` knows which finding F2 was
  // stats describe what is reported, not what was found before filtering
  return {
    findings: kept,
    stats: {
      files: reviewables(g).length,
      verified: kept.filter((f) => f.class === 'verified').length,
      judged: kept.filter((f) => f.class === 'judged').length,
      dismissed,
    },
    failures,
    plan,
    skippedChecks: [...skipped].map(([check, missing]) => ({ check, missing })),
    unavailableChecks: [...unavailable].map(([check, missing]) => ({ check, missing })),
    usage: budget.finish(),
    budgetStop,
    cancelled: opts.signal?.aborted ?? false,
    droppedPosition: positioned.dropped,
  }
}
