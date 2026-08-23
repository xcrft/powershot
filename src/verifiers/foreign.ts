import type { Verifier } from '#app/types.js'
import { foreignScopeCreep } from './foreign-scope-creep.js'
import { foreignCopyPasteDrift } from './foreign-copy-paste-drift.js'
import { foreignDroppedGuard } from './foreign-dropped-guard.js'
import { foreignReinvented } from './foreign-reinvented.js'
import { foreignPhantomConfig } from './foreign-phantom-config.js'

export { foreignScopeCreep, foreignCopyPasteDrift, foreignDroppedGuard, foreignReinvented, foreignPhantomConfig }
export { tokensFor } from './foreign-tokens.js'

/** The checks that read a tree-sitter parse rather than a TypeScript program. */
export const FOREIGN_VERIFIERS: Verifier[] = [
  foreignScopeCreep,
  foreignCopyPasteDrift,
  foreignDroppedGuard,
  foreignReinvented,
  foreignPhantomConfig,
]
