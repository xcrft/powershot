import { dirname, join } from 'node:path'
import type { Finding, Ground, Verifier } from '#app/types.js'
import { isPhantom, localModules, pythonManifest } from '#app/lang/python-deps.js'
import { isPhantomGem, rubyLocal, rubyManifest } from '#app/lang/ruby-deps.js'

/** An import nothing installs, in a language with no build step to catch it. */
export const foreignPhantomDep: Verifier = {
  name: 'phantom-dep',
  needs: ['syntax'],
  supports: (file) => file.pack.name === 'python' || file.pack.name === 'ruby',
  run(g: Ground): Finding[] {
    return [...pythonFindings(g), ...rubyFindings(g)]
  },
}

function rubyFindings(g: Ground): Finding[] {
  const ruby = g.foreign.filter((f) => f.pack.name === 'ruby')
  if (ruby.length === 0) return []

  const manifest = rubyManifest(g.root)
  if (!manifest) return []
  const local = rubyLocal(g.root)

  const findings: Finding[] = []
  for (const file of ruby) {
    for (const required of file.pack.imports?.(file.tree.rootNode) ?? []) {
      const line = required.node.startPosition.row + 1
      if (!file.changed.added.has(line)) continue
      if (!isPhantomGem(required.name, manifest, local)) continue

      findings.push({
        id: '',
        class: 'verified',
        check: 'phantom-dep',
        severity: 'high',
        confidence: 'firm',
        file: file.path,
        line,
        span: { column: required.node.startPosition.column + 1, length: Math.min(required.node.text.length, 60) },
        title: 'Requires "' + required.name + '", which is neither stdlib, local, nor a declared gem',
        evidence: { oracle: manifest.file, detail: 'not found in the manifest, the standard library, or this repository' },
        fix: 'Add it to ' + manifest.file.split(', ')[0] + ', or drop the require if it was invented',
      })
    }
  }
  return findings
}

function pythonFindings(g: Ground): Finding[] {
    const python = g.foreign.filter((f) => f.pack.name === 'python')
    if (python.length === 0) return []

    const local = localModules(g.root)

    const findings: Finding[] = []
    for (const file of python) {
      // the manifests governing this file, not just the repository's own
      const manifest = pythonManifest(g.root, dirname(join(g.root, file.path)))
      if (!manifest) continue

      for (const imported of file.pack.imports?.(file.tree.rootNode) ?? []) {
        const line = imported.node.startPosition.row + 1
        if (!file.changed.added.has(line)) continue
        if (!isPhantom(imported.name, manifest, local)) continue

        findings.push({
          id: '',
          class: 'verified',
          check: 'phantom-dep',
          severity: 'high',
          // firm, not proven: a package can be installed by means this cannot see —
          // vendored, system-wide, or an editable install outside the manifest
          confidence: 'firm',
          file: file.path,
          line,
          span: { column: imported.node.startPosition.column + 1, length: Math.min(imported.node.text.length, 60) },
          title: 'Imports "' + imported.name + '", which is neither stdlib, local, nor a declared dependency',
          evidence: { oracle: manifest.file, detail: 'not found in the manifest, the standard library, or this repository' },
          fix: 'Add it to ' + manifest.file.split(', ')[0] + ', or drop the import if it was invented',
        })
      }
    }
    return findings
}
