import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { stripControl } from '#app/text.js'
import {
  expectedHeadShaFromEnvironment,
  githubPullRequestApiFromEnvironment,
  requiredEnvironment,
  type ExistingIssueComment,
} from './api.js'

export const LEGACY_SUMMARY_MARKER = '<!-- powershot:summary:v1 -->'

const BOT_LOGIN = 'github-actions[bot]'
const LEGACY_HEADING = /^## PowerShot(?:\r?\n|$)/

export interface SummaryCommentApi {
  headSha(): Promise<string>
  listIssueComments(): Promise<ExistingIssueComment[]>
  createIssueComment(body: string): Promise<ExistingIssueComment>
  updateIssueComment(id: number, body: string): Promise<void>
  deleteIssueComment(id: number): Promise<void>
}

export type SummarySyncResult = {
  state: 'created' | 'updated' | 'migrated' | 'unchanged' | 'outdated'
  commentId?: number
  retired: number
}

/** Scope ownership to one workflow job without exposing its repository path in the comment. */
export function summaryMarker(scope: string): string {
  if (scope.length === 0) throw new Error('PowerShot summary scope is required')
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, 24)
  return `<!-- powershot:summary:v2:${digest} -->`
}

/** Stable workflow identity: keep the repository/path, discard its moving ref. */
export function workflowCommentScope(workflowRef: string, job: string): string {
  const structuralSeparator = workflowRef.indexOf('@refs/')
  const separator = structuralSeparator === -1 ? workflowRef.lastIndexOf('@') : structuralSeparator
  if (separator < 1 || separator === workflowRef.length - 1) {
    throw new Error('GITHUB_WORKFLOW_REF must contain a workflow path and ref')
  }
  if (job.length === 0) throw new Error('GITHUB_JOB is required')
  return `${workflowRef.slice(0, separator)}:${job}`
}

function headMarker(headSha: string): string {
  return `<!-- powershot:head:${headSha.toLowerCase()} -->`
}

export function summaryCommentBody(markdown: string, marker: string, headSha: string): string {
  const report = markdown.trimEnd()
  const ownership = `${marker}\n${headMarker(headSha)}`
  return report.length === 0 ? ownership : `${ownership}\n\n${report}`
}

function owns(body: string, marker: string): boolean {
  return body === marker || body.startsWith(marker + '\n') || body.startsWith(marker + '\r\n')
}

function ownsHead(body: string, marker: string, headSha: string): boolean {
  const ownership = `${marker}\n${headMarker(headSha)}`
  return body === ownership || body.startsWith(ownership + '\n') || body.startsWith(ownership + '\r\n')
}

function latest(comments: ExistingIssueComment[]): ExistingIssueComment | undefined {
  return comments.reduce<ExistingIssueComment | undefined>(
    (selected, comment) => selected === undefined || comment.id > selected.id ? comment : selected,
    undefined,
  )
}

async function retireComments(
  api: SummaryCommentApi,
  comments: ExistingIssueComment[],
  keepId?: number,
): Promise<number> {
  const staleIds = comments
    .filter((comment) => comment.id !== keepId)
    .map((comment) => comment.id)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort((left, right) => left - right)
  for (const id of staleIds) await api.deleteIssueComment(id)
  return staleIds.length
}

async function retireCreatedIfUnchanged(
  api: SummaryCommentApi,
  id: number,
  body: string,
): Promise<number> {
  const created = (await api.listIssueComments())
    .find((comment) => comment.id === id && comment.body === body)
  if (created === undefined) return 0
  await api.deleteIssueComment(id)
  return 1
}

async function reconcileCandidate(
  api: SummaryCommentApi,
  marker: string,
  body: string,
  expectedHeadSha: string,
  state: SummarySyncResult['state'],
  previousHeadComments: ExistingIssueComment[],
  createdByThisRun?: ExistingIssueComment,
  legacy?: ExistingIssueComment,
): Promise<SummarySyncResult> {
  // REST has no atomic create-if-absent. Relisting makes same-head participants
  // converge without allowing an old-head run to patch or retire a newer candidate.
  const reconciled = (await api.listIssueComments()).filter((comment) =>
    comment.user?.login === BOT_LOGIN &&
    owns(comment.body, marker) &&
    ownsHead(comment.body, marker, expectedHeadSha),
  )
  if (await api.headSha() !== expectedHeadSha) {
    const retired = createdByThisRun === undefined
      ? 0
      : await retireCreatedIfUnchanged(api, createdByThisRun.id, body)
    return { state: 'outdated', retired }
  }
  const keep = latest(reconciled)
  if (keep === undefined) throw new Error('GitHub API did not return the summary comment it created')
  const retired = await retireComments(
    api,
    [...reconciled, ...previousHeadComments, ...(legacy === undefined ? [] : [legacy])],
    keep.id,
  )
  if (await api.headSha() !== expectedHeadSha) {
    const createdRetired = createdByThisRun === undefined
      ? 0
      : await retireCreatedIfUnchanged(api, createdByThisRun.id, body)
    return { state: 'outdated', retired: retired + createdRetired }
  }
  return { state, commentId: keep.id, retired }
}

async function createCandidate(
  api: SummaryCommentApi,
  marker: string,
  body: string,
  expectedHeadSha: string,
  state: 'created' | 'migrated',
  previousHeadComments: ExistingIssueComment[],
  legacy?: ExistingIssueComment,
): Promise<SummarySyncResult> {
  const created = await api.createIssueComment(body)
  if (await api.headSha() !== expectedHeadSha) {
    const retired = await retireCreatedIfUnchanged(api, created.id, body)
    return { state: 'outdated', retired }
  }
  return reconcileCandidate(
    api,
    marker,
    body,
    expectedHeadSha,
    state,
    previousHeadComments,
    created,
    legacy,
  )
}

/** Reconcile only this workflow's PowerShot summary against the current pull-request head. */
export async function syncSummaryComment(
  api: SummaryCommentApi,
  markdown: string,
  expectedHeadSha: string,
  scope: string,
): Promise<SummarySyncResult> {
  if (await api.headSha() !== expectedHeadSha) return { state: 'outdated', retired: 0 }

  const marker = summaryMarker(scope)
  const body = summaryCommentBody(markdown, marker, expectedHeadSha)
  const comments = await api.listIssueComments()
  if (await api.headSha() !== expectedHeadSha) return { state: 'outdated', retired: 0 }

  const botComments = comments.filter((comment) => comment.user?.login === BOT_LOGIN)
  const markedComments = botComments.filter((comment) => owns(comment.body, marker))
  const currentHeadComments = markedComments.filter((comment) =>
    ownsHead(comment.body, marker, expectedHeadSha),
  )
  const previousHeadComments = markedComments.filter((comment) =>
    !ownsHead(comment.body, marker, expectedHeadSha),
  )
  const candidate = latest(currentHeadComments)

  if (candidate !== undefined) {
    const state = candidate.body === body ? 'unchanged' : 'updated'
    if (state === 'updated') {
      // A comment id never changes head ownership. This PATCH can race only with
      // another run for the same head, never with a newer pull-request head.
      await api.updateIssueComment(candidate.id, body)
      if (await api.headSha() !== expectedHeadSha) return { state: 'outdated', retired: 0 }
    }
    return reconcileCandidate(api, marker, body, expectedHeadSha, state, previousHeadComments)
  }

  // Legacy comments have no workflow or head identity, so claiming one with
  // PATCH would let two workflows overwrite each other. Create the scoped,
  // head-owned replacement first and retire only the legacy snapshot later.
  const legacy = latest(botComments.filter((comment) =>
    owns(comment.body, LEGACY_SUMMARY_MARKER) || LEGACY_HEADING.test(comment.body),
  ))
  if (legacy !== undefined) {
    return createCandidate(
      api,
      marker,
      body,
      expectedHeadSha,
      'migrated',
      previousHeadComments,
      legacy,
    )
  }
  return createCandidate(api, marker, body, expectedHeadSha, 'created', previousHeadComments)
}

function oneLine(value: string, limit: number): string {
  return stripControl(value).replace(/\r?\n/g, ' ').slice(0, limit)
}

async function main(): Promise<void> {
  const result = await syncSummaryComment(
    githubPullRequestApiFromEnvironment(),
    await readFile('powershot.md', 'utf8'),
    expectedHeadShaFromEnvironment(),
    workflowCommentScope(
      requiredEnvironment('GITHUB_WORKFLOW_REF'),
      requiredEnvironment('GITHUB_JOB'),
    ),
  )
  if (result.state === 'outdated') {
    process.stdout.write('PowerShot skipped the summary because the pull request head changed.\n')
    return
  }
  const retired = result.retired === 0 ? '' : ` ${result.retired} duplicate(s) retired.`
  process.stdout.write(`PowerShot summary comment: ${result.state}.${retired}\n`)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('PowerShot summary comment failed: ' + oneLine(message, 1_000) + '\n')
    process.exitCode = 1
  })
}
