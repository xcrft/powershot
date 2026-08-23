#!/usr/bin/env node
import { runCli } from './cli/app.js'

runCli().then(
  (code) => process.exit(code),
  (error: Error) => {
    process.stderr.write('psh: ' + error.message + '\n')
    process.exit(2)
  },
)
