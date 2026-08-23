import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { review } from './review.js'
import type { ReviewResult } from './review.js'
import { openTargetTree, withTargetTree } from './snapshot.js'
import type { Finding } from './types.js'
import { decode } from './text.js'
import { completionOf, type Completion } from './manifest.js'

/**
 * A labelled case: the findings a change is known to deserve. Used where ground truth
 * exists. Where it does not, `replayRepo` measures the thing that needs no labels —
 * how often the checks speak up on code that was already reviewed and merged.
 */
export type BenchCase = {
  name: string
  /** commit to review, in the repo under test */
  commit: string
  /** every finding this commit should produce, as `check@file:line` */
  expect: string[]
}

export type Score = { tp: number; fp: number; fn: number }

export function key(f: Finding): string {
  return f.check + '@' + f.file + ':' + f.line
}

export function score(found: Finding[], expected: string[]): Score {
  const got = new Set(found.map(key))
  const want = new Set(expected)
  let tp = 0
  for (const k of got) if (want.has(k)) tp++
  return { tp, fp: got.size - tp, fn: want.size - tp }
}

export function precision(s: Score): number {
  return s.tp + s.fp === 0 ? 1 : s.tp / (s.tp + s.fp)
}
export function recall(s: Score): number {
  return s.tp + s.fn === 0 ? 1 : s.tp / (s.tp + s.fn)
}
export function f1(s: Score): number {
  const p = precision(s)
  const r = recall(s)
  return p + r === 0 ? 0 : (2 * p * r) / (p + r)
}

function git(root: string, args: string[]): string {
  return decode(execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }))
}

/** The most recent commits, newest first, excluding merges (a merge has no own diff). */
export function recentCommits(root: string, count: number): string[] {
  return git(root, ['log', '--no-merges', '--format=%H', '-n', String(count)]).split('\n').filter(Boolean)
}

export type RepoReport = {
  commits: number
  findings: number
  byCheck: Map<string, number>
  /** commits that produced at least one finding */
  noisy: { commit: string; subject: string; findings: Finding[] }[]
  /** planned limits such as a missing optional oracle */
  partial: number
  /** execution or selection failures */
  failed: number
  /**
   * Reported apart, always. The two halves have different error modes and different
   * costs, and one number over both hides which of them a change improved.
   */
  verified: number
  judged: number
  /** how confident the deterministic half claimed to be */
  byConfidence: Map<string, number>
  /** what the run could not look at, which is what makes a clean result mean anything */
  coverage: { selected: number; limited: number; waived: number; failed: number }
  /**
   * Commits reported clean by a run that was not complete. This is the number that
   * matters most: a false clean is the only failure a reviewer cannot see.
   */
  falseClean: number
  /** judged findings on a line the change added, against ones merely nearby */
  positions: { added: number; context: number }
  usage: { requests: number; inputTokens: number; outputTokens: number; elapsedMs: number }
}

export function reviewCompletion(result: ReviewResult): Completion {
  return completionOf({
    files: result.plan?.items() ?? [],
    units: [],
    skippedChecks: result.skippedChecks ?? [],
    failures: result.failures,
    cancelled: result.cancelled,
    budgetStop: result.budgetStop,
  })
}

export function incompleteReasons(result: ReviewResult): string[] {
  return reviewCompletion(result).notLookedAt
}

/**
 * Replay real history through the deterministic checks.
 *
 * On a codebase that was reviewed and shipped, a finding is far more likely to be a
 * false positive than a defect nobody noticed. That makes this the cheapest honest
 * precision signal available without labelling anything — and it is measured on real
 * code rather than on fixtures written by the same person who wrote the checks.
 */
export async function replayRepo(root: string, count: number, onProgress?: (s: string) => void): Promise<RepoReport> {
  const commits = recentCommits(root, count)
  const report: RepoReport = {
    commits: 0, findings: 0, byCheck: new Map(), noisy: [], partial: 0, failed: 0,
    verified: 0, judged: 0, byConfidence: new Map(),
    coverage: { selected: 0, limited: 0, waived: 0, failed: 0 },
    falseClean: 0, positions: { added: 0, context: 0 },
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 },
  }
  if (commits.length === 0) return report

  // One checkout, moved from commit to commit. Each replay has to read the files as
  // they were at that commit — measuring an old diff against today's working tree is
  // what made the previous numbers describe a state that never existed — but paying
  // for a fresh worktree per commit would make the benchmark unusable.
  const tree = openTargetTree(root, commits[0]!)
  try {
  for (const commit of commits) {
    let result: ReviewResult
    try {
      tree.checkout(commit)
      // the policy of the commit being replayed, not today's: scoring old history
      // against a rule set written afterwards measures the rules, not the history
      result = await review({
        root: tree.dir,
        stateRoot: root,
        range: { commit },
        config: loadConfig(tree.dir),
        verifyOnly: true,
      })
    } catch {
      // a commit the pipeline cannot process (submodule, binary-only, first commit)
      report.failed++
      continue
    }
    for (const item of result.plan?.items() ?? []) {
      if (item.disposition === 'selected' && item.missing?.length) report.coverage.limited++
      else report.coverage[item.disposition] = (report.coverage[item.disposition] ?? 0) + 1
    }
    if (result.usage) {
      report.usage.requests += result.usage.requests
      report.usage.inputTokens += result.usage.inputTokens
      report.usage.outputTokens += result.usage.outputTokens
      report.usage.elapsedMs += result.usage.elapsedMs
    }
    const completion = reviewCompletion(result)
    if (result.findings.length === 0 && completion.state !== 'complete') report.falseClean++
    if (result.failures.length > 0 || completion.state === 'failed') {
      report.failed++
      continue
    }
    if (completion.state === 'partial') {
      report.partial++
      continue
    }
    report.commits++
    if (result.findings.length === 0) continue

    report.findings += result.findings.length
    for (const f of result.findings) {
      report.byCheck.set(f.check, (report.byCheck.get(f.check) ?? 0) + 1)
      if (f.class === 'verified') report.verified++
      else report.judged++
      report.byConfidence.set(f.confidence, (report.byConfidence.get(f.confidence) ?? 0) + 1)
      if (f.positioning === 'added') report.positions.added++
      else if (f.positioning === 'context') report.positions.context++
    }

    let subject = ''
    try {
      subject = git(root, ['log', '-1', '--format=%s', commit]).trim()
    } catch {
      // a missing subject is cosmetic; the findings still count
    }
    report.noisy.push({ commit: commit.slice(0, 8), subject, findings: result.findings })
    onProgress?.(commit.slice(0, 8) + ' ' + result.findings.length + ' finding(s) — ' + subject)
  }
  } finally {
    tree.close()
  }
  return report
}

/** Labelled cases from a directory of .json files, for the repos where truth is known. */
export function loadCases(dir: string): BenchCase[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as BenchCase)
}

export type CaseReport =
  | { name: string; complete: true; score: Score; found: Finding[] }
  | { name: string; complete: false; state: 'partial' | 'failed'; reasons: string[]; found: Finding[] }

export async function runCases(root: string, cases: BenchCase[]): Promise<CaseReport[]> {
  const out: CaseReport[] = []
  for (const c of cases) {
    // the same bug replayRepo had: scoring an old commit against today's tree makes
    // every labelled expectation a claim about a state that never existed
    try {
      const result = await withTargetTree(root, { commit: c.commit }, (tree) =>
        review({ root: tree, stateRoot: root, range: { commit: c.commit }, config: loadConfig(tree), verifyOnly: true }))
      const completion = reviewCompletion(result)
      if (completion.state !== 'complete') {
        out.push({ name: c.name, complete: false, state: completion.state, reasons: completion.notLookedAt, found: result.findings })
      }
      else out.push({ name: c.name, complete: true, score: score(result.findings, c.expect), found: result.findings })
    } catch (error) {
      out.push({ name: c.name, complete: false, state: 'failed', reasons: [(error as Error).message], found: [] })
    }
  }
  return out
}
