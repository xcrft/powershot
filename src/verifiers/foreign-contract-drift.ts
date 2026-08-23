import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { pyrightDiagnostics } from '#app/lang/pyright.js'
import { decode, lines } from '#app/text.js'
import { repoPath } from '#app/fspolicy.js'

/**
 * A Python signature changed and callers were left behind.
 *
 * The break is detected syntactically — a required parameter appeared, or one is
 * gone — which is cheap and needs no checker. Finding who broke is where pyright
 * earns its place: its errors land *at the call sites*, in files this change never
 * touched, which is precisely the blast radius nothing else in a Python project is
 * watching for.
 */
function callsFunction(line: string, name: string): boolean {
  let from = 0
  for (;;) {
    const at = line.indexOf(name, from)
    if (at === -1) return false
    const before = at === 0 ? '' : line[at - 1]!
    const after = line.slice(at + name.length).trimStart()
    const isWordBoundary = before === '' || !/[A-Za-z0-9_.]/.test(before)
    if (isWordBoundary && after.startsWith('(')) return true
    from = at + name.length
  }
}

export const foreignContractDrift: Verifier = {
  name: 'contract-drift',
  needs: ['syntax', 'base', 'python-types'],
  run(g: Ground): Finding[] {
    const python = g.foreign.filter((f) => f.pack.name === 'python' && f.beforeTree)
    if (python.length === 0) return []

    // which callables lost compatibility, and in which file
    const broken = new Map<string, { file: string; line: number; detail: string }>()
    for (const file of python) {
      const now = file.pack.signatures?.(file.tree.rootNode)
      const was = file.pack.signatures?.(file.beforeTree!.rootNode)
      if (!now || !was) continue

      for (const [name, before] of was) {
        const after = now.get(name)
        if (!after) continue
        if (after.required > before.required) {
          broken.set(name, {
            file: file.path,
            line: after.node.startPosition.row + 1,
            detail: 'now requires ' + after.required + ' argument(s), was ' + before.required,
          })
        } else if (after.params.length < before.params.length) {
          broken.set(name, {
            file: file.path,
            line: after.node.startPosition.row + 1,
            detail: 'takes ' + after.params.length + ' parameter(s), was ' + before.params.length,
          })
        }
      }
    }
    if (broken.size === 0) return []
    const changed = new Set(python.map((f) => f.path))
    const diagnostics = pyrightDiagnostics(g.root, [g.root])

    // group the broken callers by the function they were calling
    const callers = new Map<string, { file: string; line: number }[]>()
    for (const d of diagnostics) {
      if (d.rule !== 'reportCallIssue' && d.rule !== 'reportArgumentType') continue
      const path = repoPath(g.root, d.file)
      if (changed.has(path)) continue // a caller inside the change is not left behind

      let source = ''
      try {
        source = lines(decode(readFileSync(join(g.root, path))))[d.line - 1] ?? ''
      } catch {
        continue // cannot read it, cannot attribute it
      }
      for (const name of broken.keys()) {
        // attribute the error only where the line actually calls the changed function
        if (!callsFunction(source, name)) continue
        const list = callers.get(name) ?? []
        list.push({ file: path, line: d.line })
        callers.set(name, list)
      }
    }

    const findings: Finding[] = []
    for (const [name, sites] of callers) {
      const where = broken.get(name)!
      const shown = sites.slice(0, 3).map((s) => s.file + ':' + s.line).join(', ')
      findings.push({
        id: '',
        class: 'verified',
        check: 'contract-drift',
        severity: 'high',
        confidence: 'proven',
        file: where.file,
        line: where.line,
        title:
          name + '() ' + where.detail + ', and ' + sites.length + ' call site(s) outside this change now fail',
        evidence: {
          oracle: 'pyright',
          detail: 'the checker reports a call error at ' + shown + (sites.length > 3 ? ' and others' : ''),
        },
        fix: 'Update the call sites, or keep the old shape working with a default',
      })
    }
    return findings
  },
}
