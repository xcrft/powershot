import { join } from 'node:path'
import { repoRoot } from '#app/git.js'
import { dim, yellow } from '#app/report/ansi.js'

const REPOSITORY_ENV = /_API_KEY$/

export function loadRepositoryEnv(): void {
  try {
    if (process.env.CI) return
    const inherited = { ...process.env }
    process.loadEnvFile(join(repoRoot(process.cwd()), '.env'))

    const refused: string[] = []
    for (const key of Object.keys(process.env)) {
      if (Object.prototype.hasOwnProperty.call(inherited, key)) continue
      if (REPOSITORY_ENV.test(key)) continue
      delete process.env[key]
      refused.push(key)
    }
    for (const [key, value] of Object.entries(inherited)) {
      if (value !== undefined) process.env[key] = value
    }
    if (refused.length > 0) {
      process.stderr.write(
        yellow(' ◇ .env') + dim('     ignored ' + refused.join(', ') + ' — only *_API_KEY may come from the repository') + '\n',
      )
    }
  } catch {
    // A missing .env and a directory outside Git are both normal startup states.
  }
}
