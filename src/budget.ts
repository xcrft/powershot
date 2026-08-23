/** What one run may spend before it stops and says what it did not reach. */
export type Limits = {
  requests?: number
  inputTokens?: number
  outputTokens?: number
  toolCalls?: number
  elapsedMs?: number
  units?: number
}

export type Usage = {
  requests: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  elapsedMs: number
  units: number
}

/**
 * A ceiling on what a review may spend, and a record of what it did.
 *
 * Exhaustion is a planned `partial` outcome with unreached units named, not an
 * execution failure or a clean verdict.
 */
export class Budget {
  readonly used: Usage = { requests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, elapsedMs: 0, units: 0 }
  private readonly startedAt: number

  constructor(
    private readonly limits: Limits = {},
    now = Date.now(),
  ) {
    this.startedAt = now
  }

  /** What is exhausted, or undefined while there is room for one more unit. */
  exhausted(now = Date.now()): string | undefined {
    const elapsed = now - this.startedAt
    const over: [keyof Limits, number, number | undefined][] = [
      ['requests', this.used.requests, this.limits.requests],
      ['inputTokens', this.used.inputTokens, this.limits.inputTokens],
      ['outputTokens', this.used.outputTokens, this.limits.outputTokens],
      ['toolCalls', this.used.toolCalls, this.limits.toolCalls],
      ['elapsedMs', elapsed, this.limits.elapsedMs],
      ['units', this.used.units, this.limits.units],
    ]
    for (const [name, used, limit] of over) {
      if (limit !== undefined && used >= limit) return String(name) + ' budget reached (' + used + '/' + limit + ')'
    }
    return undefined
  }

  spend(delta: Partial<Usage>): void {
    for (const [k, v] of Object.entries(delta)) {
      if (typeof v === 'number') this.used[k as keyof Usage] += v
    }
  }

  finish(now = Date.now()): Usage {
    this.used.elapsedMs = now - this.startedAt
    return this.used
  }
}

/** `--budget requests=40,inputTokens=2000000,elapsedMs=600000` */
export function parseLimits(spec: string): Limits | string {
  const limits: Limits = {}
  const known = new Set(['requests', 'inputTokens', 'outputTokens', 'toolCalls', 'elapsedMs', 'units'])
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf('=')
    const name = at === -1 ? part : part.slice(0, at)
    if (!known.has(name)) return 'unknown budget "' + name + '" — known: ' + [...known].join(', ')
    const value = Number(part.slice(at + 1))
    if (!Number.isFinite(value) || value <= 0) return 'budget ' + name + ' must be a positive number'
    limits[name as keyof Limits] = value
  }
  return limits
}
