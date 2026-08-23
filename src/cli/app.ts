import { parseCliArgs, HELP } from './args.js'
import { runAgentCommand } from './agent-command.js'
import { runBenchCommand } from './bench-command.js'
import { runDismissCommand } from './dismiss-command.js'
import { loadRepositoryEnv } from './environment.js'
import { runReviewCommand, type ReviewCommand } from './review-command.js'
import { runSessionCommand } from './session-command.js'

const REVIEW_COMMANDS = new Set<ReviewCommand>(['review', 'scan', 'delegate'])

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  loadRepositoryEnv()
  const { values, positionals } = parseCliArgs(args)

  if (values.help || positionals[0] === 'help') {
    process.stdout.write(HELP)
    return 0
  }

  const command = positionals[0] ?? 'review'
  if (command === 'bench') return runBenchCommand(values)
  if (command === 'agent') return runAgentCommand(positionals[1])
  if (command === 'dismiss') return runDismissCommand(positionals, values.reason)
  if (command === 'session') return runSessionCommand(positionals)
  if (!REVIEW_COMMANDS.has(command as ReviewCommand)) {
    process.stderr.write('Unknown command "' + command + '". Try: psh --help\n')
    return 2
  }
  return runReviewCommand(command as ReviewCommand, values, positionals)
}
