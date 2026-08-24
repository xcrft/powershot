import { stripControl } from '#app/text.js'

const API_VERSION = '2022-11-28'
const API_TIMEOUT_MS = 20_000
const MAX_API_PAGES = 100

export type PullFile = { filename: string; patch?: string }
export type InlineComment = { path: string; line: number; side: 'RIGHT'; body: string }
export type ExistingReviewComment = {
  id: number
  path: string
  line: number | null
  body: string
  user?: { login?: string }
  inReplyToId?: number
}
export type ExistingIssueComment = {
  id: number
  body: string
  user?: { login?: string }
}

export function createReviewPayload(commitId: string, comments: InlineComment[]): {
  commit_id: string
  body: string
  event: 'COMMENT'
  comments: InlineComment[]
} {
  return {
    commit_id: commitId,
    body: `PowerShot posted ${comments.length} proven verified finding(s) on changed lines.`,
    event: 'COMMENT',
    comments,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`GitHub API returned no ${name}`)
  return value
}

function nextLink(value: string | null): string | undefined {
  if (value === null) return undefined
  for (const part of value.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part)
    if (match?.[2] === 'next') return match[1]
  }
  return undefined
}

function errorDetail(value: string): string {
  return stripControl(value).replace(/\r?\n/g, ' ').slice(0, 500)
}

function issueComment(value: unknown, index: number): ExistingIssueComment {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.body !== null && typeof value.body !== 'string')
  ) {
    throw new Error(`GitHub API issue comment ${index + 1} has an invalid contract`)
  }
  const user = record(value.user) && typeof value.user.login === 'string'
    ? { login: value.user.login }
    : undefined
  return { id: Number(value.id), body: value.body ?? '', user }
}

/** Shared REST transport for the two pull-request publication adapters. */
export class GitHubPullRequestApi {
  private readonly base: string
  private readonly pullPath: string
  private readonly issuePath: string
  private readonly issueCommentPath: string

  constructor(
    apiUrl: string,
    private readonly token: string,
    owner: string,
    repository: string,
    private readonly pullNumber: number,
  ) {
    this.base = apiUrl.replace(/\/$/, '')
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
    this.pullPath = `${repositoryPath}/pulls`
    this.issuePath = `${repositoryPath}/issues/${pullNumber}`
    this.issueCommentPath = `${repositoryPath}/issues/comments`
  }

  private url(endpoint: string): string {
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) return this.base + endpoint
    if (endpoint !== this.base && !endpoint.startsWith(this.base + '/')) {
      throw new Error('GitHub pagination left the configured API origin')
    }
    return endpoint
  }

  private async request(
    method: string,
    endpoint: string,
    body?: unknown,
    acceptedStatuses: number[] = [],
  ): Promise<{ data: unknown; next?: string }> {
    const response = await fetch(this.url(endpoint), {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'PowerShot',
        'X-GitHub-Api-Version': API_VERSION,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    const source = await response.text()
    if (!response.ok) {
      if (acceptedStatuses.includes(response.status)) return { data: undefined }
      throw new Error(`GitHub API ${method} failed with ${response.status}: ${errorDetail(source)}`)
    }
    const data: unknown = source.length === 0 ? undefined : JSON.parse(source)
    return { data, next: nextLink(response.headers.get('link')) }
  }

  private async all(endpoint: string): Promise<unknown[]> {
    const out: unknown[] = []
    const seen = new Set<string>()
    let next: string | undefined = endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100'
    for (let page = 0; next !== undefined; page++) {
      if (page >= MAX_API_PAGES) throw new Error('GitHub API pagination exceeded its safety limit')
      if (seen.has(next)) throw new Error('GitHub API returned a pagination cycle')
      seen.add(next)
      const response = await this.request('GET', next)
      if (!Array.isArray(response.data)) throw new Error('GitHub API returned a non-array page')
      out.push(...response.data)
      next = response.next
    }
    return out
  }

  async headSha(): Promise<string> {
    const { data } = await this.request('GET', `${this.pullPath}/${this.pullNumber}`)
    if (!record(data) || !record(data.head)) throw new Error('GitHub API returned no pull request head')
    return requiredString(data.head.sha, 'pull request head SHA')
  }

  async listFiles(): Promise<PullFile[]> {
    const values = await this.all(`${this.pullPath}/${this.pullNumber}/files`)
    return values.map((value, index) => {
      if (!record(value) || typeof value.filename !== 'string') {
        throw new Error(`GitHub API pull file ${index + 1} has an invalid contract`)
      }
      if (value.patch !== undefined && typeof value.patch !== 'string') {
        throw new Error(`GitHub API pull file ${index + 1} has an invalid patch`)
      }
      return { filename: value.filename, patch: value.patch }
    })
  }

  async listReviewComments(): Promise<ExistingReviewComment[]> {
    const values = await this.all(`${this.pullPath}/${this.pullNumber}/comments`)
    return values.map((value, index) => {
      if (
        !record(value) ||
        !Number.isSafeInteger(value.id) ||
        typeof value.path !== 'string' ||
        (value.line !== null && !Number.isSafeInteger(value.line)) ||
        (value.body !== null && typeof value.body !== 'string') ||
        (value.in_reply_to_id !== undefined && value.in_reply_to_id !== null && !Number.isSafeInteger(value.in_reply_to_id))
      ) {
        throw new Error(`GitHub API review comment ${index + 1} has an invalid contract`)
      }
      const user = record(value.user) && typeof value.user.login === 'string'
        ? { login: value.user.login }
        : undefined
      return {
        id: Number(value.id),
        path: value.path,
        line: value.line === null ? null : Number(value.line),
        body: value.body ?? '',
        user,
        inReplyToId: value.in_reply_to_id === undefined || value.in_reply_to_id === null
          ? undefined
          : Number(value.in_reply_to_id),
      }
    })
  }

  async createReview(commitId: string, comments: InlineComment[]): Promise<void> {
    await this.request('POST', `${this.pullPath}/${this.pullNumber}/reviews`, createReviewPayload(commitId, comments))
  }

  async deleteReviewComment(id: number): Promise<void> {
    await this.request('DELETE', `${this.pullPath}/comments/${id}`, undefined, [404])
  }

  async listIssueComments(): Promise<ExistingIssueComment[]> {
    const values = await this.all(`${this.issuePath}/comments`)
    return values.map(issueComment)
  }

  async createIssueComment(body: string): Promise<ExistingIssueComment> {
    const { data } = await this.request('POST', `${this.issuePath}/comments`, { body })
    return issueComment(data, 0)
  }

  async updateIssueComment(id: number, body: string): Promise<void> {
    await this.request('PATCH', `${this.issueCommentPath}/${id}`, { body })
  }

  async deleteIssueComment(id: number): Promise<void> {
    await this.request('DELETE', `${this.issueCommentPath}/${id}`, undefined, [404])
  }
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

export function expectedHeadShaFromEnvironment(): string {
  const value = requiredEnvironment('POWERSHOT_HEAD_SHA')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw new Error('POWERSHOT_HEAD_SHA is invalid')
  return value
}

export function githubPullRequestApiFromEnvironment(): GitHubPullRequestApi {
  const repository = requiredEnvironment('GITHUB_REPOSITORY').split('/')
  if (repository.length !== 2 || !repository[0] || !repository[1]) {
    throw new Error('GITHUB_REPOSITORY must be owner/repository')
  }
  const pullNumber = Number(requiredEnvironment('POWERSHOT_PR_NUMBER'))
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error('POWERSHOT_PR_NUMBER must be positive')
  }
  return new GitHubPullRequestApi(
    requiredEnvironment('GITHUB_API_URL'),
    requiredEnvironment('GITHUB_TOKEN'),
    repository[0],
    repository[1],
    pullNumber,
  )
}
