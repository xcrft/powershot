import type { Verifier } from '#app/types.js'
import { phantomApi } from './phantom-api.js'
import { phantomDep } from './phantom-dep.js'
import { reinvented } from './reinvented.js'
import { droppedGuard } from './dropped-guard.js'
import { vacuousTest } from './vacuous-test.js'
import { swallowedError } from './swallowed-error.js'
import { assertionDrift } from './assertion-drift.js'
import { contractDrift } from './contract-drift.js'
import { scopeCreep } from './scope-creep.js'
import { phantomConfig } from './phantom-config.js'
import { copyPasteDrift } from './copy-paste-drift.js'
import { deadOnArrival } from './dead-on-arrival.js'
import { lyingComment } from './lying-comment.js'
import { foreignSwallowedError } from './foreign-swallowed-error.js'
import { FOREIGN_VERIFIERS } from './foreign.js'
import { foreignPhantomDep } from './foreign-phantom-dep.js'
import { foreignPhantomApi } from './foreign-phantom-api.js'
import { foreignContractDrift } from './foreign-contract-drift.js'
import { FOREIGN_TEST_VERIFIERS } from './foreign-tests.js'

/** The tree-sitter half shares its names with the TypeScript half; the ids differ. */
const tagged = (list: Verifier[]): Verifier[] =>
  list.map((v) => ({ ...v, id: 'foreign-' + v.name, domain: v.domain ?? 'foreign' }))

export const VERIFIERS: Verifier[] = [
  ...[
    phantomApi, phantomDep, reinvented, droppedGuard, swallowedError, vacuousTest,
    assertionDrift, contractDrift, scopeCreep, phantomConfig, copyPasteDrift,
    deadOnArrival, lyingComment,
  ].map((v) => ({ ...v, domain: 'typescript' as const })),
  ...tagged([
    foreignSwallowedError,
    ...FOREIGN_VERIFIERS,
    foreignPhantomDep,
    { ...foreignPhantomApi, domain: 'python' },
    { ...foreignContractDrift, domain: 'python' },
    ...FOREIGN_TEST_VERIFIERS,
  ]),
].map((v) => ({ ...v, id: v.id ?? v.name }))

export {
  phantomApi,
  phantomDep,
  reinvented,
  droppedGuard,
  swallowedError,
  vacuousTest,
  assertionDrift,
  contractDrift,
  scopeCreep,
  phantomConfig,
  copyPasteDrift,
  deadOnArrival,
  lyingComment,
}
