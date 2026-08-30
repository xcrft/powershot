import type { Config } from '#app/config.js'
import type { Budget } from '#app/budget.js'

export type Msg = { system: string; user: string }

/**
 * Why a provider call failed, in terms a caller can act on.
 *
 * A single Error carrying a status code makes every caller re-derive whether to
 * retry, whether to tell the user to fix something, and whether the run is worth
 * continuing. Providers disagree on status codes and message shapes; the taxonomy is
 * where that disagreement stops.
 */
export type FailureKind =
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'overload'
  | 'timeout'
  | 'cancelled'
  | 'bad_response'
  | 'configuration'
  | 'unknown'

export class ProviderError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly provider: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(provider + ' ' + kind + ': ' + redact(message))
    this.name = 'ProviderError'
  }
}

/**
 * A key must never reach a log, a manifest, or a pull-request comment.
 *
 * Provider error bodies echo request context, and a failure reason is one of the few
 * strings this tool copies verbatim into places other people read.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{20,})/g, '<redacted>')
    .replace(/([Bb]earer\s+)[A-Za-z0-9._-]{8,}/g, '$1<redacted>')
    .replace(/("?(?:api[_-]?key|x-api-key|authorization)"?\s*[:=]\s*"?)[^",\s]{8,}/gi, '$1<redacted>')
    .slice(0, 2000)
}

function glmBillingFailure(body: string): boolean {
  try {
    const json = JSON.parse(body) as { error?: { code?: string | number; message?: string } }
    if (String(json.error?.code ?? '') === '1113') return true
    if (/insufficient balance|no resource package|please recharge/i.test(json.error?.message ?? '')) return true
  } catch {
    // Some gateways return provider errors as text or HTML. The message remains
    // enough to distinguish a permanent billing failure from a transient 429.
  }
  return /insufficient balance|no resource package|please recharge/i.test(body)
}

function classify(status: number, body: string, provider: string): ProviderError {
  if (provider === 'GLM' && glmBillingFailure(body)) {
    return new ProviderError(
      'billing',
      provider,
      'insufficient balance or no resource package; recharge the Z.AI account or attach a resource package',
      false,
      status,
    )
  }
  if (status === 401 || status === 403) {
    return new ProviderError('auth', provider, 'rejected the key (' + status + '). ' + body, false, status)
  }
  if (status === 429) return new ProviderError('rate_limit', provider, body, true, status)
  if (status === 529 || status === 503 || status === 502) {
    return new ProviderError('overload', provider, body, true, status)
  }
  if (status === 400 || status === 404 || status === 422) {
    // a model name that does not exist, or a request this provider will never accept
    return new ProviderError('configuration', provider, 'rejected the request (' + status + '). ' + body, false, status)
  }
  return new ProviderError(status >= 500 ? 'overload' : 'unknown', provider, body, status >= 500, status)
}

/** What one call cost, as each provider chooses to report it. */
export type CallUsage = { inputTokens: number; outputTokens: number; requests: number; toolCalls: number }

export type Completion = { text: string; usage: CallUsage }

const NO_USAGE = (): CallUsage => ({ inputTokens: 0, outputTokens: 0, requests: 0, toolCalls: 0 })

export type ToolRunner = { defs: unknown[]; run: (name: string, input: Record<string, unknown>) => string }

/** How many times a judge may call tools before it must answer. Bounds the bill. */
const MAX_TURNS = 8

/** A hung request must fail, not wait. */
const REQUEST_TIMEOUT_MS = Number(process.env.POWERSHOT_TIMEOUT_MS) || 120_000

async function post(url: string, init: RequestInit, provider: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    const err = e as { name?: string; message?: string }
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new ProviderError('timeout', provider, 'no response within ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + 's', true)
    }
    throw new ProviderError('unknown', provider, err.message ?? String(e), true)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One request, no SDK. The providers speak JSON over HTTPS and each needs only one
 * bounded call shape, so a dependency would buy nothing.
 */
export async function complete(cfg: Config, msg: Msg, maxTokens = 2000, tools?: ToolRunner): Promise<Completion> {
  if (cfg.provider === 'openai') return openai(cfg, msg, maxTokens)
  if (cfg.provider === 'gemini') return gemini(cfg, msg, maxTokens)
  if (cfg.provider === 'glm') return glm(cfg, msg, maxTokens)
  return anthropic(cfg, msg, maxTokens, tools)
}

export function apiKey(cfg: Config): string | undefined {
  if (cfg.provider === 'openai') return process.env.OPENAI_API_KEY
  if (cfg.provider === 'gemini') return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (cfg.provider === 'glm') return process.env.GLM_API_KEY
  return process.env.ANTHROPIC_API_KEY
}

/** *_BASE_URL is a base, not a full endpoint — join without doubling the slash. */
export function endpoint(base: string | undefined, fallback: string, path: string): string {
  return (base ?? fallback).replace(/\/+$/, '') + path
}

/**
 * The agent loop: the judge may read files, search, and walk references before it
 * answers, so it can check a suspicion against the repository instead of guessing
 * from the diff alone. Bounded by MAX_TURNS — an agent that will not conclude is a
 * cost leak, and the last turn's text is taken as its answer either way.
 */
async function anthropic(cfg: Config, msg: Msg, maxTokens: number, tools?: ToolRunner): Promise<Completion> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new ProviderError('configuration', 'Anthropic', 'ANTHROPIC_API_KEY is not set')
  const url = endpoint(process.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com', '/v1/messages')
  const messages: any[] = [{ role: 'user', content: msg.user }]
  const usage = NO_USAGE()
  let text = ''

  for (let turn = 0; turn < (tools ? MAX_TURNS : 1); turn++) {
    // The system prompt and tool definitions are byte-identical across every review
    // unit and every judge, so they are marked cacheable: a change split into N units
    // pays to read them once instead of N times. Only the prefix is cached — the diff
    // itself differs per call and is not marked.
    const cacheable = cfg.promptCache !== false
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: maxTokens,
      // A review that reports nine findings on one run and none on the next is not a
      // review anyone can act on, and it makes a resumed run disagree with the one it
      // continues. The Gemini path already pinned this; the default was left floating.
      temperature: 0,
      system: cacheable
        ? [{ type: 'text', text: msg.system, cache_control: { type: 'ephemeral' } }]
        : msg.system,
      messages,
    }
    if (tools) {
      body.tools = cacheable
        ? tools.defs.map((d, i) =>
            i === tools.defs.length - 1 ? { ...(d as object), cache_control: { type: 'ephemeral' } } : d,
          )
        : tools.defs
    }

    const res = await post(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      },
      'Anthropic',
    )
    if (!res.ok) throw classify(res.status, await res.text(), 'Anthropic')
    const json: any = await res.json()
    usage.requests++
    usage.inputTokens += Number(json.usage?.input_tokens ?? 0) + Number(json.usage?.cache_read_input_tokens ?? 0)
    usage.outputTokens += Number(json.usage?.output_tokens ?? 0)
    const content: any[] = json.content ?? []
    text = content.map((b) => b.text ?? '').join('')

    const calls = content.filter((b) => b.type === 'tool_use')
    if (!tools || calls.length === 0) return { text, usage }
    usage.toolCalls += calls.length

    messages.push({ role: 'assistant', content })
    messages.push({
      role: 'user',
      content: calls.map((c) => ({
        type: 'tool_result',
        tool_use_id: c.id,
        content: tools.run(c.name, (c.input ?? {}) as Record<string, unknown>),
      })),
    })
  }
  return { text, usage }
}

async function openai(cfg: Config, msg: Msg, maxTokens: number): Promise<Completion> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new ProviderError('configuration', 'OpenAI', 'OPENAI_API_KEY is not set')
  const res = await post(
    endpoint(process.env.OPENAI_BASE_URL, 'https://api.openai.com/v1', '/chat/completions'),
    {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: cfg.model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: msg.system },
        { role: 'user', content: msg.user },
      ],
    }),
    },
    'OpenAI',
  )
  if (!res.ok) throw classify(res.status, await res.text(), 'OpenAI')
  const json: any = await res.json()
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: {
      requests: 1,
      inputTokens: Number(json.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json.usage?.completion_tokens ?? 0),
      toolCalls: 0,
    },
  }
}

/**
 * GLM exposes an OpenAI-compatible chat-completions surface. Keep its credential and
 * endpoint separate from the OpenAI provider so selecting GLM cannot accidentally
 * send one vendor's key to another vendor's host.
 */
async function glm(cfg: Config, msg: Msg, maxTokens: number): Promise<Completion> {
  const key = process.env.GLM_API_KEY
  if (!key) throw new ProviderError('configuration', 'GLM', 'GLM_API_KEY is not set')
  const glm53 = /^glm-5\.3(?:-|$)/.test(cfg.model)
  const body: Record<string, unknown> = {
    model: cfg.model,
    // GLM-5.3 counts required reasoning against max_tokens. A 2K ceiling can be
    // consumed entirely by reasoning_content, leaving a successful response with no
    // assistant content. PowerShot's judges are bounded single-shot classifications,
    // so light reasoning plus an 8K ceiling leaves room for the final JSON without
    // turning each unit into a long-horizon agent task.
    max_tokens: glm53 ? Math.max(maxTokens, 8192) : maxTokens,
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: msg.system },
      { role: 'user', content: msg.user },
    ],
  }
  if (glm53) {
    body.thinking = { type: 'enabled' }
    body.reasoning_effort = 'low'
  }
  const res = await post(
    endpoint(process.env.AI_BASE_URL, 'https://api.z.ai/api/paas/v4', '/chat/completions'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'en-US,en',
        authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(body),
    },
    'GLM',
  )
  if (!res.ok) throw classify(res.status, await res.text(), 'GLM')
  const json: any = await res.json()
  const choice = json.choices?.[0]
  const text = choice?.message?.content
  if (typeof text !== 'string' || text.trim().length === 0) {
    const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown'
    const completionTokens = Number(json.usage?.completion_tokens ?? 0)
    const reasoningChars = typeof choice?.message?.reasoning_content === 'string'
      ? choice.message.reasoning_content.length
      : 0
    throw new ProviderError(
      'bad_response',
      'GLM',
      'returned no assistant content (finish_reason=' + finish +
        ', completion_tokens=' + completionTokens + ', reasoning_chars=' + reasoningChars + ')',
      false,
    )
  }
  return {
    text,
    usage: {
      requests: 1,
      inputTokens: Number(json.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json.usage?.completion_tokens ?? 0),
      toolCalls: 0,
    },
  }
}

/**
 * Gemini speaks a different shape but the same idea: one system instruction, one user
 * turn, text back. Single-shot — the tool loop is Anthropic-only for now, and a judge
 * without tools still does the whole job from the diff.
 */
async function gemini(cfg: Config, msg: Msg, maxTokens: number): Promise<Completion> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!key) throw new ProviderError('configuration', 'Gemini', 'GEMINI_API_KEY is not set')
  const base = endpoint(process.env.GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com', '/v1beta/models/')
  const res = await post(
    base + encodeURIComponent(cfg.model) + ':generateContent',
    {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: msg.system }] },
      contents: [{ role: 'user', parts: [{ text: msg.user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
    }),
    },
    'Gemini',
  )
  if (!res.ok) throw classify(res.status, await res.text(), 'Gemini')
  const json: any = await res.json()
  return {
    text: (json.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join(''),
    usage: {
      requests: 1,
      inputTokens: Number(json.usageMetadata?.promptTokenCount ?? 0),
      outputTokens: Number(json.usageMetadata?.candidatesTokenCount ?? 0),
      toolCalls: 0,
    },
  }
}

/** Models like to wrap JSON in prose or fences. Take the first array we can parse. */
export function extractJsonArray(text: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text].filter(Boolean) as string[]
  for (const c of candidates) {
    const start = c.indexOf('[')
    const end = c.lastIndexOf(']')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(c.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    } catch {
      // try the next candidate
    }
  }
  return []
}
