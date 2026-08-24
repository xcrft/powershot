import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { stripControl } from '#app/text.js'
import { GitHubPullRequestApi, type ExistingIssueComment } from './inline-comments.js'

export const SUMMARY_MARKER = '<!-- powershot:summary:v1 -->'

const BOT_LOGIN = 'github-actions[bot]'
const LEGACY_HEADING = /^## PowerShot(?:\r?\n|$)/

export interface SummaryCommentApi {
  listIssueComments(): Promise<ExistingIssueComment[]>
  createIssueComment(body: string): Promise<void>
  updateIssueComment(id: number, body: string): Promise<void>
}

export type SummarySyncResult = {
  state: 'created' | 'updated' | 'migrated' | 'unchanged'
  commentId?: number
}

export function summaryCommentBody(markdown: string): string {
  const report = markdown.trimEnd()
  return report.length === 0 ? SUMMARY_MARKER : `${SUMMARY_MARKER}\n\n${report}`
}

function latest(comments: ExistingIssueComment[]): ExistingIssueComment | undefined {
  return comments.reduce<ExistingIssueComment | undefined>(
    (selected, comment) => selected === undefined || comment.id > selected.id ? comment : selected,
    undefined,
  )
}

/** Update only a PowerShot-owned comment; never use another workflow's last bot comment. */
export async function syncSummaryComment(
  api: SummaryCommentApi,
  markdown: string,
): Promise<SummarySyncResult> {
  const body = summaryCommentBody(markdown)
  const comments = await api.listIssueComments()
  const botComments = comments.filter((comment) => comment.user?.login === BOT_LOGIN)
  const marked = latest(botComments.filter((comment) => comment.body.includes(SUMMARY_MARKER)))

  if (marked !== undefined) {
    if (marked.body === body) return { state: 'unchanged', commentId: marked.id }
    await api.updateIssueComment(marked.id, body)
    return { state: 'updated', commentId: marked.id }
  }

  // v1.1.2 and older had no marker. Reuse the newest unmistakable legacy body once,
  // but never infer ownership from the shared github-actions[bot] identity alone.
  const legacy = latest(botComments.filter((comment) => LEGACY_HEADING.test(comment.body)))
  if (legacy !== undefined) {
    await api.updateIssueComment(legacy.id, body)
    return { state: 'migrated', commentId: legacy.id }
  }

  await api.createIssueComment(body)
  return { state: 'created' }
}

function environment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function oneLine(value: string, limit: number): string {
  return stripControl(value).replace(/\r?\n/g, ' ').slice(0, limit)
}

async function main(): Promise<void> {
  const repository = environment('GITHUB_REPOSITORY').split('/')
  if (repository.length !== 2 || !repository[0] || !repository[1]) {
    throw new Error('GITHUB_REPOSITORY must be owner/repository')
  }
  const pullNumber = Number(environment('POWERSHOT_PR_NUMBER'))
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error('POWERSHOT_PR_NUMBER must be positive')
  }

  const api = new GitHubPullRequestApi(
    environment('GITHUB_API_URL'),
    environment('GITHUB_TOKEN'),
    repository[0],
    repository[1],
    pullNumber,
  )
  const result = await syncSummaryComment(api, await readFile('powershot.md', 'utf8'))
  process.stdout.write(`PowerShot summary comment: ${result.state}.\n`)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('PowerShot summary comment failed: ' + oneLine(message, 1_000) + '\n')
    process.exitCode = 1
  })
}
