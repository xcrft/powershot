import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { stripControl } from '#app/text.js'
import { SEVERITIES, type Finding } from '#app/types.js'
import {
  githubPullRequestApiFromEnvironment,
  requiredEnvironment,
  type ExistingReviewComment,
  type InlineComment,
  type PullFile,
} from './api.js'

const INLINE_COMMENT_LIMIT = 10
const BOT_LOGIN = 'github-actions[bot]'
const MARKER_PATTERN = /<!-- powershot:inline:v1:[a-f0-9]{24} -->/
const COMMONMARK_PUNCTUATION = new Set(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`)

export type ReconcilePlan = { create: InlineComment[]; staleIds: number[]; kept: number }

export interface PullRequestApi {
  headSha(): Promise<string>
  listFiles(): Promise<PullFile[]>
  listReviewComments(): Promise<ExistingReviewComment[]>
  createReview(commitId: string, comments: InlineComment[]): Promise<void>
  deleteReviewComment(id: number): Promise<void>
}

export type InlineSyncResult = {
  outdated: boolean
  desired: number
  created: number
  kept: number
  retired: number
}

function oneLine(value: string, limit: number): string {
  return stripControl(value).replace(/\r?\n/g, ' ').slice(0, limit)
}

/** Untrusted finding prose rendered as literal CommonMark without mentions or HTML. */
function literal(value: string, limit = 1_200): string {
  let out = ''
  for (const char of oneLine(value, limit)) {
    if (char === '&') out += '&amp;'
    else if (char === '<') out += '&lt;'
    else if (char === '>') out += '&gt;'
    else if (char === '@') out += '&#64;'
    else out += COMMONMARK_PUNCTUATION.has(char) ? '\\' + char : char
  }
  return out
}

function code(value: string): string {
  return oneLine(value, 160).replace(/`/g, '')
}

/** Stable across reruns; unlike the display id, it does not depend on finding order. */
export function inlineMarker(finding: Finding): string {
  const key = JSON.stringify([finding.check, finding.file, finding.line, finding.title])
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return `<!-- powershot:inline:v1:${digest} -->`
}

function inlineBody(finding: Finding): string {
  const body = [
    `**PowerShot · ${finding.severity.toUpperCase()} · \`${code(finding.check)}\` · verified/proven**`,
    '',
    literal(finding.title),
  ]
  if (finding.evidence) {
    body.push('', `> _${literal(finding.evidence.oracle, 240)}_: ${literal(finding.evidence.detail)}`)
  }
  body.push('', inlineMarker(finding))
  return body.join('\n')
}

/** Parse right-side line numbers from the unified patch returned by GitHub. */
export function addedLinesFromPatch(patch: string): Set<number> {
  const added = new Set<number>()
  let rightLine: number | undefined

  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      rightLine = Number(hunk[1])
      continue
    }
    if (rightLine === undefined || line === '\\ No newline at end of file') continue
    if (line.startsWith('+')) {
      added.add(rightLine)
      rightLine++
    } else if (line.startsWith('-')) {
      continue
    } else if (line.startsWith(' ')) {
      rightLine++
    }
  }
  return added
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Select the small, high-confidence subset suitable for review comments.
 *
 * A missing or truncated GitHub patch is deliberately ineligible: the finding is
 * still in the full report, but there is no proven right-side location to attach to.
 */
export function selectInlineComments(
  findings: Finding[],
  files: PullFile[],
  limit = INLINE_COMMENT_LIMIT,
): InlineComment[] {
  const changed = new Map<string, Set<number>>()
  for (const file of files) {
    if (file.patch === undefined) continue
    const lines = changed.get(file.filename) ?? new Set<number>()
    for (const line of addedLinesFromPatch(file.patch)) lines.add(line)
    changed.set(file.filename, lines)
  }

  const eligible = findings
    .filter((finding) =>
      finding.class === 'verified' &&
      finding.confidence === 'proven' &&
      SEVERITIES.indexOf(finding.severity) >= SEVERITIES.indexOf('medium') &&
      changed.get(finding.file)?.has(finding.line) === true,
    )
    .sort((left, right) =>
      SEVERITIES.indexOf(right.severity) - SEVERITIES.indexOf(left.severity) ||
      compareText(left.file, right.file) ||
      left.line - right.line ||
      compareText(left.check, right.check) ||
      compareText(left.title, right.title),
    )

  const out: InlineComment[] = []
  const seen = new Set<string>()
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 0
  const bounded = Math.min(INLINE_COMMENT_LIMIT, Math.max(0, requested))
  if (bounded === 0) return out
  for (const finding of eligible) {
    const marker = inlineMarker(finding)
    if (seen.has(marker)) continue
    seen.add(marker)
    out.push({ path: finding.file, line: finding.line, side: 'RIGHT', body: inlineBody(finding) })
    if (out.length === bounded) break
  }
  return out
}

function markerIn(body: string): string | undefined {
  return MARKER_PATTERN.exec(body)?.[0]
}

/** Plan an idempotent rerun without deleting any human-authored comment. */
export function reconcileInlineComments(
  desired: InlineComment[],
  existing: ExistingReviewComment[],
): ReconcilePlan {
  const managed = existing.filter((comment) =>
    comment.user?.login === BOT_LOGIN && markerIn(comment.body) !== undefined,
  )
  const repliedTo = new Set(existing.flatMap((comment) =>
    comment.inReplyToId === undefined ? [] : [comment.inReplyToId],
  ))
  const used = new Set<number>()
  const create: InlineComment[] = []
  let kept = 0

  for (const wanted of desired) {
    const marker = markerIn(wanted.body)
    const matches = managed.filter((comment) =>
      !used.has(comment.id) &&
      markerIn(comment.body) === marker &&
      comment.path === wanted.path &&
      comment.line === wanted.line &&
      comment.body === wanted.body,
    )
    const match = matches.find((comment) => repliedTo.has(comment.id)) ?? matches[0]
    if (match) {
      used.add(match.id)
      kept++
    } else {
      create.push(wanted)
    }
  }

  const staleIds = [...new Set(managed
    .filter((comment) => !used.has(comment.id) && !repliedTo.has(comment.id))
    .map((comment) => comment.id))]
    .sort((left, right) => left - right)
  return { create, staleIds, kept }
}

/** Create missing comments as one review, then retire superseded bot comments. */
export async function syncInlineComments(
  api: PullRequestApi,
  findings: Finding[],
  expectedHeadSha: string,
  limit = INLINE_COMMENT_LIMIT,
): Promise<InlineSyncResult> {
  if (await api.headSha() !== expectedHeadSha) {
    return { outdated: true, desired: 0, created: 0, kept: 0, retired: 0 }
  }

  const [files, existing] = await Promise.all([api.listFiles(), api.listReviewComments()])
  if (await api.headSha() !== expectedHeadSha) {
    return { outdated: true, desired: 0, created: 0, kept: 0, retired: 0 }
  }

  const desired = selectInlineComments(findings, files, limit)
  const plan = reconcileInlineComments(desired, existing)
  if (plan.create.length > 0) await api.createReview(expectedHeadSha, plan.create)
  for (const id of plan.staleIds) await api.deleteReviewComment(id)

  return {
    outdated: false,
    desired: desired.length,
    created: plan.create.length,
    kept: plan.kept,
    retired: plan.staleIds.length,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseReviewFindings(source: string): Finding[] {
  const document: unknown = JSON.parse(source)
  if (!record(document) || !Array.isArray(document.findings)) {
    throw new Error('powershot.json does not contain a findings array')
  }

  return document.findings.map((value, index) => {
    if (!record(value)) throw new Error(`powershot.json finding ${index + 1} is not an object`)
    if (
      typeof value.id !== 'string' ||
      (value.class !== 'verified' && value.class !== 'judged') ||
      typeof value.check !== 'string' ||
      !SEVERITIES.includes(value.severity as (typeof SEVERITIES)[number]) ||
      (value.confidence !== 'proven' && value.confidence !== 'firm' && value.confidence !== 'tentative') ||
      typeof value.file !== 'string' ||
      !Number.isSafeInteger(value.line) || Number(value.line) < 1 ||
      typeof value.title !== 'string'
    ) {
      throw new Error(`powershot.json finding ${index + 1} has an invalid contract`)
    }

    let evidence: Finding['evidence']
    if (value.evidence !== undefined) {
      if (!record(value.evidence) || typeof value.evidence.oracle !== 'string' || typeof value.evidence.detail !== 'string') {
        throw new Error(`powershot.json finding ${index + 1} has invalid evidence`)
      }
      evidence = { oracle: value.evidence.oracle, detail: value.evidence.detail }
    }

    return {
      id: value.id,
      class: value.class,
      check: value.check,
      severity: value.severity as Finding['severity'],
      confidence: value.confidence,
      file: value.file,
      line: Number(value.line),
      title: value.title,
      evidence,
    }
  })
}

async function main(): Promise<void> {
  const expectedHeadSha = requiredEnvironment('POWERSHOT_HEAD_SHA')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expectedHeadSha)) throw new Error('POWERSHOT_HEAD_SHA is invalid')
  const findings = parseReviewFindings(await readFile('powershot.json', 'utf8'))
  const api = githubPullRequestApiFromEnvironment()
  const result = await syncInlineComments(api, findings, expectedHeadSha)
  if (result.outdated) {
    process.stdout.write('PowerShot skipped inline comments because the pull request head changed.\n')
    return
  }
  process.stdout.write(
    `PowerShot inline comments: ${result.created} created, ${result.kept} kept, ${result.retired} retired.\n`,
  )
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('PowerShot inline comments failed: ' + oneLine(message, 1_000) + '\n')
    process.exitCode = 1
  })
}
