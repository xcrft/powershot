import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TARGETS, findTarget } from '#app/agents.js'
import { repoRoot } from '#app/git.js'
import { dim, bold, steel } from '#app/report/ansi.js'

export function runAgentCommand(name?: string): number {
  if (!name || name === 'list') {
    process.stdout.write('\n ' + bold('Agent targets') + '\n\n')
    for (const target of TARGETS) {
      process.stdout.write('  ' + steel(target.name.padEnd(8)) + dim(target.path) + '\n')
      process.stdout.write('  ' + ' '.repeat(8) + dim(target.serves) + '\n\n')
    }
    process.stdout.write(dim(' psh agent agents    # the standard file, covers most tools\n\n'))
    return 0
  }

  const target = findTarget(name)
  if (!target) {
    process.stderr.write('Unknown agent "' + name + '". Try: psh agent list\n')
    return 2
  }
  const output = join(repoRoot(process.cwd()), target.path)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, target.render())
  process.stdout.write(output + '\n')
  return 0
}
