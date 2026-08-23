import { readFileSync } from 'node:fs'
import type { Ground } from '#app/types.js'
import { relPath } from '#app/ground.js'
import { deniedPath, insideRepo } from '#app/fspolicy.js'

const MAX_BYTES = 60_000
const MAX_MATCHES = 40

export type ToolDef = {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

export const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description:
      'Read a file from the repository under review. Use it to see the full definition of something the diff only partly shows.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'repo-relative path, e.g. src/billing/invoice.ts' },
        start: { type: 'number', description: 'first line (1-based, optional)' },
        end: { type: 'number', description: 'last line (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Search the repository for a regular expression. Use it to find callers, similar code, or existing helpers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path_contains: { type: 'string', description: 'only search files whose path contains this (optional)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'references',
    description: 'List every place a symbol is referenced. Use it to judge whether a change breaks callers.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'exported or local symbol name' } },
      required: ['symbol'],
    },
  },
]

export function runTool(g: Ground, name: string, input: Record<string, unknown>): string {
  try {
    if (name === 'read_file') return readFile(g, input)
    if (name === 'grep') return grep(g, input)
    if (name === 'references') return references(g, input)
    return 'Unknown tool: ' + name
  } catch (e) {
    return 'Tool failed: ' + (e as Error).message
  }
}

function readFile(g: Ground, input: Record<string, unknown>): string {
  const path = String(input.path ?? '')
  const abs = insideRepo(g.root, path)
  if (!abs) return 'Refused: that path is outside the repository or is not readable for review.'

  const inProject = g.project.getSourceFile(abs)
  const text = inProject ? inProject.getFullText() : readFileSync(abs, 'utf8')
  const lines = text.split('\n')

  const start = Math.max(1, Number(input.start ?? 1))
  const end = Math.min(lines.length, Number(input.end ?? lines.length))
  const slice = lines.slice(start - 1, end)

  let body = slice.map((l, i) => String(start + i).padStart(5) + ' | ' + l).join('\n')
  if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES) + '\n… truncated'
  return body || '(empty)'
}

function grep(g: Ground, input: Record<string, unknown>): string {
  let re: RegExp
  try {
    re = new RegExp(String(input.pattern ?? ''), 'g')
  } catch (e) {
    return 'Not a valid regular expression: ' + (e as Error).message
  }
  const filter = input.path_contains === undefined ? undefined : String(input.path_contains)

  const hits: string[] = []
  for (const sf of g.project.getSourceFiles()) {
    const abs = sf.getFilePath()
    // the project glob can pull in a file through a symlinked directory, so the
    // boundary is re-checked here rather than trusted from how the file got loaded
    if (abs.includes('/node_modules/') || !insideRepo(g.root, abs)) continue
    const rel = relPath(sf, g.root)
    if (filter && !rel.includes(filter)) continue

    const lines = sf.getFullText().split('\n')
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      if (!re.test(lines[i] ?? '')) continue
      hits.push(rel + ':' + (i + 1) + ': ' + (lines[i] ?? '').trim().slice(0, 160))
      if (hits.length >= MAX_MATCHES) return hits.join('\n') + '\n… more matches not shown'
    }
  }
  return hits.length > 0 ? hits.join('\n') : 'No matches.'
}

function references(g: Ground, input: Record<string, unknown>): string {
  const symbol = String(input.symbol ?? '')
  if (!symbol) return 'No symbol given.'

  for (const sf of g.project.getSourceFiles()) {
    const path = String(sf.getFilePath())
    if (path.includes('/node_modules/') || !insideRepo(g.root, path)) continue
    const decl = sf.getFunction(symbol) ?? sf.getVariableDeclaration(symbol) ?? sf.getClass(symbol)
    if (!decl) continue

    const refs = decl
      .findReferencesAsNodes()
      .filter((n) => insideRepo(g.root, String(n.getSourceFile().getFilePath())) !== undefined)
      .map((n) => relPath(n.getSourceFile(), g.root) + ':' + n.getStartLineNumber())
      .filter((r) => !r.includes('node_modules'))

    return refs.length === 0
      ? symbol + ' is declared in ' + relPath(sf, g.root) + ' and referenced nowhere.'
      : symbol + ' declared in ' + relPath(sf, g.root) + ', referenced at:\n' + [...new Set(refs)].slice(0, MAX_MATCHES).join('\n')
  }
  return 'No declaration named ' + symbol + ' found in the project.'
}
