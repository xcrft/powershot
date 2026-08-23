import { randomBytes } from 'node:crypto'
import { PACKAGE_VERSION } from './package-meta.js'

/** OpenTelemetry without the SDK. */
type Span = { name: string; start: number; end?: number; attrs: Record<string, string | number> }

const HEX = (n: number): string => randomBytes(n).toString('hex')

export class Trace {
  private readonly spans: Span[] = []
  private readonly traceId = HEX(16)
  private readonly endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  get enabled(): boolean {
    return Boolean(this.endpoint)
  }

  /** Returns a function that closes the span; a no-op when tracing is off. */
  span(name: string, attrs: Record<string, string | number> = {}): (extra?: Record<string, string | number>) => void {
    if (!this.enabled) return () => {}
    const s: Span = { name, start: Date.now(), attrs }
    this.spans.push(s)
    return (extra) => {
      s.end = Date.now()
      Object.assign(s.attrs, extra ?? {})
    }
  }

  /**
   * Never throws and never blocks a review: a collector that is down, slow, or absent
   * must not turn a completed review into a failed command.
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.spans.length === 0) return
    const url = this.endpoint!.replace(/\/+$/, '') + '/v1/traces'

    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'powershot' } },
              { key: 'service.version', value: { stringValue: PACKAGE_VERSION } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'powershot' },
              spans: this.spans.map((s) => ({
                traceId: this.traceId,
                spanId: HEX(8),
                name: s.name,
                kind: 1,
                startTimeUnixNano: String(s.start * 1_000_000),
                endTimeUnixNano: String((s.end ?? Date.now()) * 1_000_000),
                attributes: Object.entries(s.attrs).map(([key, v]) => ({
                  key,
                  value: typeof v === 'number' ? { intValue: String(Math.round(v)) } : { stringValue: String(v) },
                })),
              })),
            },
          ],
        },
      ],
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)
    } catch {
      // telemetry is never worth failing a review over
    }
  }
}
