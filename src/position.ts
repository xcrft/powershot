import type { Finding, Ground } from './types.js'
import { reviewables, shownLines } from './bundle.js'
import { lines as splitLines } from './text.js'

const CONTEXT_LINES = 1

/** undefined when the span cannot be pointed at: a caret in the wrong column accuses
 *  the wrong token. */
export function caretFor(
  span: { column: number; length: number } | undefined,
  lineText: string | undefined,
  dedent: number,
): { offset: number; length: number } | undefined {
  if (!span || lineText === undefined) return undefined
  const offset = span.column - 1 - dedent
  if (offset < 0 || offset >= lineText.length) return undefined
  return { offset, length: Math.max(1, Math.min(span.length, lineText.length - offset)) }
}

/**
 * A model writes its own file and line, so it can point anywhere.
 *
 * Being inside the file is not enough: a judge is only shown the changed lines and a
 * little context, so a finding outside that window is about code the model never saw.
 * Which of the two justified it is recorded, because "the change did this" and "the
 * change sits next to this" are different claims for a reader to weigh.
 */
export function positionable(findings: Finding[], g: Ground): { kept: Finding[]; dropped: number } {
  const files = reviewables(g)
  const lineCount = new Map(files.map((r) => [r.path, splitLines(r.text).length]))
  const added = new Map(files.map((r) => [r.path, r.added]))
  const shown = shownLines(files)

  const kept: Finding[] = []
  for (const f of findings) {
    if (f.class === 'verified') {
      kept.push(f)
      continue
    }
    const total = lineCount.get(f.file)
    if (total === undefined || f.line < 1 || f.line > total) continue
    if (added.get(f.file)?.has(f.line)) kept.push({ ...f, positioning: 'added' })
    else if (shown.get(f.file)?.has(f.line)) kept.push({ ...f, positioning: 'context' })
  }
  return { kept, dropped: findings.length - kept.length }
}

/** From the source that was analysed, not from disk — an old commit differs. */
export function attachFrames(findings: Finding[], g: Ground): Finding[] {
  const byFile = new Map<string, string[]>()
  for (const { sf, changed } of g.files) byFile.set(changed.path, splitLines(sf.getFullText()))
  for (const f of g.foreign) byFile.set(f.path, splitLines(f.tree.rootNode.text))

  return findings.map((f) => {
    const lines = byFile.get(f.file)
    if (!lines || f.line < 1 || f.line > lines.length) return f

    const firstLine = Math.max(1, f.line - CONTEXT_LINES)
    const lastLine = Math.min(lines.length, f.line + CONTEXT_LINES)
    let start = firstLine
    let slice = lines.slice(firstLine - 1, lastLine).map((l) => l.replace(/\s+$/, ''))

    while (slice.length > 1 && slice[0] === '' && start < f.line) {
      slice = slice.slice(1)
      start++
    }
    while (slice.length > 1 && slice[slice.length - 1] === '') slice = slice.slice(0, -1)

    const indents = slice.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
    const dedent = indents.length > 0 ? Math.min(...indents) : 0

    const rendered = slice.map((l) => l.slice(dedent))

    // dedented coordinates, so the renderer only counts characters
    const caret = caretFor(f.span, rendered[f.line - start], dedent)

    // the whole line as it would be committed: untouched source, not the frame
    let suggestion: string | undefined
    const original = lines[f.line - 1]
    if (f.replacement !== undefined && f.span && original !== undefined) {
      const from = f.span.column - 1
      if (from >= 0 && from + f.span.length <= original.length) {
        suggestion = original.slice(0, from) + f.replacement + original.slice(from + f.span.length)
      }
    } else if (f.suggestion !== undefined && original !== undefined) {
      suggestion = validateSuggestion(f.suggestion, original)
    }

    return { ...f, suggestion, frame: { firstLine: start, lines: rendered, caret } }
  })
}

/**
 * Indentation always from the file, never the model: measured, a judge that got the
 * fix exactly right returned it at four spaces where the file used two.
 */
export function validateSuggestion(suggested: string, original: string): string | undefined {
  const body = suggested.trim()
  if (body === '' || body === original.trim()) return undefined
  return (/^\s*/.exec(original)?.[0] ?? '') + body
}
