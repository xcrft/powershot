<p align="center">
  <img src="docs/assets/powershot-logo.png" width="156" alt="PowerShot logo">
</p>

<h1 align="center">PowerShot</h1>

<p align="center">
  <strong>Oracle-first code review for machine-written code.</strong><br>
  Verify with code. Judge with the model.
</p>

<p align="center">
  <a href="https://github.com/xcrft/powershot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xcrft/powershot/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@0xcraft/powershot"><img alt="npm version" src="https://img.shields.io/npm/v/@0xcraft/powershot.svg?logo=npm"></a>
  <img alt="Node.js 24 or newer" src="https://img.shields.io/badge/Node.js-24%2B-5FA04E.svg">
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-3B82F6.svg"></a>
</p>

PowerShot reviews the failure modes that plausible-looking generated code tends to
hide: invented APIs, undeclared dependencies, dropped guards, swallowed errors,
tests that prove nothing, bent expectations, stale callers, and duplicated helpers.

It asks self-contained parsers, manifests, and pre/post ASTs first, then uses compiler
types and reference graphs when the environment can supply them. Optional model judges
only handle questions that still require judgement.

<table>
  <tr>
    <td width="33%"><strong>Deterministic first</strong><br>Local checks need no model, key, tokens, or network calls.</td>
    <td width="33%"><strong>Honest coverage</strong><br>Portable, full, partial, and failed runs stay distinguishable.</td>
    <td width="33%"><strong>CI-native output</strong><br>One run emits terminal, Markdown, JSON, SARIF, manifest, and Code Quality reports.</td>
  </tr>
</table>

## See it in action

This is real output from a deterministic scan of an empty `catch` block:

![PowerShot CLI reporting a proven swallowed error](docs/assets/cli-preview.svg)

## Quick start

PowerShot requires Node.js 24 or newer.

```bash
npm install --global @0xcraft/powershot
psh review --verify-only
```

The package also installs the longer `powershot` command:

```bash
powershot scan src/ --verify-only
```

## How a review moves

```mermaid
flowchart LR
    subgraph input["Change"]
      DIFF["Workspace · range · commit · scan"]
    end

    subgraph engine["PowerShot engine"]
      SNAP["Target snapshot"]
      GROUND["Ground<br/>parsers · types · symbols"]
      PLAN["Plan<br/>file-level capabilities"]
      VERIFY["Verify<br/>deterministic oracles"]
      JUDGE["Judge<br/>optional model"]
      MANIFEST["Manifest<br/>authoritative state"]
    end

    subgraph output["Reports"]
      HUMAN["Terminal · Markdown"]
      MACHINE["SARIF · JSON · Code Quality"]
    end

    DIFF --> SNAP --> GROUND --> PLAN --> VERIFY --> MANIFEST
    PLAN -. only when enabled .-> JUDGE --> MANIFEST
    MANIFEST --> HUMAN
    MANIFEST --> MACHINE

    classDef change fill:#172033,stroke:#57a6ff,color:#f0f6fc,stroke-width:2px
    classDef core fill:#251a20,stroke:#ff675c,color:#f0f6fc,stroke-width:2px
    classDef report fill:#17251f,stroke:#4ac58b,color:#f0f6fc,stroke-width:2px
    class DIFF change
    class SNAP,GROUND,PLAN,VERIFY,JUDGE,MANIFEST core
    class HUMAN,MACHINE report
```

1. **Snapshot** resolves the exact tree the review is about.
2. **Ground** builds the available type, syntax, dependency, and reference oracles.
3. **Plan** assigns baseline checks and enriched semantic capabilities to each file individually.
4. **Verify** runs deterministic checks and records what actually executed.
5. **Judge** optionally reviews bounded bundles of related files.
6. **Manifest** decides whether the result is complete, partial, or failed.
7. **Report** renders the same result for people and CI consumers.

Read the full [architecture guide](docs/architecture.md) for module boundaries,
runtime sequence, invariants, and extension paths.

## Findings you can calibrate

Every finding says where it came from:

| Class | Confidence | Meaning |
|---|---|---|
| `verified` | `proven` | An oracle answered the exact question |
| `verified` | `firm` | A deterministic heuristic fired; inspect the evidence |
| `judged` | `firm` or `tentative` | A model supplied the judgement and provenance |

Publication formats make that calibration enforceable: Markdown, SARIF, and GitLab
Code Quality include `firm` agent findings and withhold `tentative` suspicions.
The JSON report, terminal, viewer, session, and judge cache retain tentative output
for inspection without presenting it as an actionable review finding.

Portable coverage is the default: self-contained oracles run without bootstrapping the
reviewed repository, while unavailable compiler/reference depth stays visible in the
manifest and reports. Set `"coverage": "strict"`, or explicitly select a check with
`--checks`, when a missing semantic oracle must make the run partial. An unavailable
oracle is never counted as a pass in either profile.

## Deterministic checks

| Check | Detects | Evidence |
|---|---|---|
| `phantom-api` | Missing members, invalid calls, incompatible APIs | Type checker |
| `phantom-dep` | Imports absent from project manifests | Dependency manifests |
| `phantom-config` | Configuration keys with no declared source | Repository config index |
| `contract-drift` | Signature changes with callers left behind | Types and references |
| `reinvented` | New cross-file declarations with a token-identical implementation, package, visibility, wrapper, and binding context | Base declaration + scoped token fingerprint |
| `dropped-guard` | Early-exit guards deleted while every other token in the file and changed source set stays unchanged | Pre/post control-flow AST |
| `swallowed-error` | Empty or ineffective error handling | AST shape |
| `vacuous-test` | Tests that do not assert behavior | Test AST |
| `assertion-drift` | Expectations changed under stable behavior | Pre/post test AST |
| `copy-paste-drift` | Clones with an inconsistent rename | Token and AST comparison |
| `dead-on-arrival` | Added code with no reachable reference | Reference graph |
| `scope-creep` | Files touched without a program-level change | Token comparison |
| `lying-comment` | Documentation contradicted by a signature | Signature and comment parser |

## CLI

```bash
# Staged, unstaged, and untracked work
psh review --verify-only

# Branch range or single commit
psh review --verify-only --from main --to HEAD
psh review --verify-only --commit <sha>

# Existing files without Git history
psh scan src/

# Select checks and severity
psh review --verify-only --checks phantom-api,swallowed-error
psh review --verify-only --min-severity high

# Create several artifacts from one verdict
psh review --verify-only \
  --report sarif=out/powershot.sarif \
  --report markdown=out/powershot.md \
  --report json=out/powershot.json
```

Useful options:

| Option | Purpose |
|---|---|
| `--verify-only` | Run deterministic checks only |
| `--checks a,b` | Run only named checks |
| `--min-severity <level>` | Filter below `info`, `low`, `medium`, `high`, or `critical` |
| `--format <format>` | Select the primary output format |
| `--report <format>=<path>` | Add an output artifact; repeat as needed |
| `--max-bundle <lines>` | Bound each optional judge unit |
| `--budget k=v,...` | Bound requests, tokens, tools, elapsed time, or units |
| `--resume <id>` | Continue a compatible saved session |
| `--no-cache` | Ignore cached judge answers |

Run `psh --help` for sessions, dismissals, delegation, agent setup, and benchmark
commands.

## Completion is a contract

```mermaid
flowchart LR
    START["Selected files and checks"] --> ACCOUNT{"Required work accounted for?"}
    ACCOUNT -- "yes" --> DEPTH{"Enriched semantic depth available?"}
    DEPTH -- "yes" --> FULL["full applicable-oracle coverage"]
    DEPTH -- "no · portable policy" --> PORTABLE["portable oracle coverage · gaps named"]
    FULL --> FINDINGS{"Findings?"}
    PORTABLE --> FINDINGS
    FINDINGS -- "no" --> CLEAN["exit 0 · complete and clean"]
    FINDINGS -- "yes" --> FOUND["exit 1 · complete with findings"]
    ACCOUNT -- "required oracle or budget gap" --> PARTIAL["exit 3 · partial"]
    ACCOUNT -- "required stage failed" --> FAILED["exit 3 · failed"]

    classDef neutral fill:#172033,stroke:#57a6ff,color:#f0f6fc,stroke-width:2px
    classDef good fill:#17251f,stroke:#4ac58b,color:#f0f6fc,stroke-width:2px
    classDef warn fill:#2a2117,stroke:#f2b84b,color:#f0f6fc,stroke-width:2px
    classDef bad fill:#2a191b,stroke:#ff675c,color:#f0f6fc,stroke-width:2px
    class START,ACCOUNT,DEPTH,FINDINGS neutral
    class CLEAN good
    class FULL,PORTABLE,FOUND,PARTIAL warn
    class FAILED bad
```

| Exit | Contract |
|---:|---|
| `0` | Review completed in full or portable coverage and found nothing at the selected severity |
| `1` | Review completed in full or portable coverage and reported findings |
| `2` | Command or Git input was invalid |
| `3` | Review is incomplete; findings may be missing |

A clean report names its effective severity threshold, deterministic/model mode,
reviewed/changed file ratio, check count, and oracle coverage level. A partial or
failed review instead says it is not a verdict and keeps the missing work visible. Use
`--format manifest` to inspect file dispositions, executed and unavailable checks,
failures, judge units, and `notLookedAt`.

## CI integration

The composite action is the shortest setup for GitHub:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0

- uses: xcrft/powershot@v1
  with:
    verify-only: 'true'
    upload-sarif: 'true'
    comment: 'true'
    inline-comments: 'true'
    fail-on-findings: 'true'
```

The default portable profile needs no install from the checked-out repository. That is
the safe default for private monorepos and fork pull requests: do not expose a package
registry credential merely to enrich a review of untrusted code. If a trusted job
already has dependencies, PowerShot uses their TypeScript declarations automatically.
Set `"coverage": "strict"` when missing compiler/reference oracles must block instead.

PowerShot discovers `tsconfig.json` and `tsconfig.*.json` along the ancestor chain of
each changed file. One review can use several independent package projects, skip
empty solution configs in favour of their leaf configs, and type-check test files
that a production config excludes. Discovery is change-scoped: unrelated packages
and configless source trees are not crawled just to build the TypeScript ground.

`@v1` follows compatible `1.x` releases. Pin the action to a full commit SHA in a
protected required workflow when immutable dependencies are required.

`inline-comments` is opt-in. It posts at most ten `verified` + `proven` findings of
`medium` severity or higher as one GitHub review, and only when GitHub confirms the
finding line was added by the pull request. Reruns keep matching bot comments and
retire stale PowerShot copies that have no replies. Human comments and discussions
are preserved. The JSON report retains every finding. The summary publishes
deterministic and `firm` agent findings and reports how many `tentative` agent
suspicions it withheld.

The [CI guide](docs/ci.md) covers exit handling, Git history, one-run/many-report
artifacts, GitLab Code Quality, local parity, and recommended gate policies.

Copy-paste examples:

- [GitHub composite Action](examples/github-actions/action.yml)
- [GitHub direct CLI workflow](examples/github-actions/cli.yml)
- [GitLab Code Quality job](examples/gitlab/.gitlab-ci.yml)

## Optional model judges

Judges cover plausible logic, test adequacy, change intent, and repository conventions.
Anthropic, OpenAI, Gemini, and GLM providers are supported.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "verifiers": { "enable": ["*"] },
  "judges": {
    "enable": ["plausible-logic", "test-adequacy", "intent"]
  },
  "coverage": "portable",
  "minSeverity": "low",
  "ignore": ["**/generated/**"],
  "promptCache": true
}
```

Save this as `powershot.config.json`, set the provider key in the surrounding
environment, and omit `--verify-only`:

```bash
export ANTHROPIC_API_KEY=...
psh review --from main --to HEAD
```

For GLM, select the provider and model in `powershot.config.json`:

```json
{
  "provider": "glm",
  "model": "glm-5.3-flash"
}
```

Set `GLM_API_KEY` in the surrounding environment. PowerShot uses the Z.AI general API
by default; set inherited `AI_BASE_URL` only for another compatible regional endpoint
or proxy. For the GLM 5.3 family, PowerShot uses the required thinking mode at low
effort with an 8K output ceiling, which keeps a short review bounded while leaving
room for the final JSON answer.
In GitHub Actions, pass the same secret through `glm-api-key`:

```yaml
- uses: xcrft/powershot@v1
  with:
    verify-only: 'false'
    glm-api-key: ${{ secrets.GLM_API_KEY }}
```

If your coding agent already has a model, delegate the judgement instead of paying for
another call:

```bash
psh delegate > /tmp/powershot-brief.md
# Follow the brief and write its JSON array to /tmp/powershot-findings.json
psh review --verify-only --absorb /tmp/powershot-findings.json
```

Delegation uses the same `SelectionPlan` and target snapshot as a real review. The
brief names every changed file as selected, policy-waived, or failed, so unsupported
or oversized files cannot disappear between task creation and absorption. For an
agent that consumes structured input, request the versioned task directly:

```bash
psh delegate --format json > /tmp/powershot-task.json
```

`powershot.delegate/v1` contains the resolved file dispositions, applicable judges,
bounded review units, changed-line excerpts, intent, and the exact output contract.
Creating either form is LLM-free and does not create a session. Deterministic checks
run when the returned finding array is absorbed by `psh review --verify-only`.

## Language coverage

| Language | Available oracles |
|---|---|
| TypeScript, JavaScript | Compiler types, references, manifests, syntax, pre/post AST |
| Python | Tree-sitter syntax and dependencies; optional `pyright` adds semantic checks |
| Ruby | Tree-sitter syntax and dependency manifests |
| Go, Java, C#, C++, PHP, Kotlin, Rust | Declared syntax-backed checks |
| C | Syntax-backed checks that do not require exception semantics |
| Solidity | Declared syntax-backed checks |

Every declared language is parsed in disposable, language-isolated workers. Sources
are sent in bounded batches, so a mixed-language monorepo does not accumulate every
compiled WASM grammar in one process. If a declared parser cannot run, the review
fails loudly; it is never silently waived. All eleven packs plus TypeScript and
JavaScript are exercised together by the integration suite.

## Project guide

| Document | Use it for |
|---|---|
| [Architecture](docs/architecture.md) | Module boundaries, runtime sequence, invariants, extensions |
| [CI integration](docs/ci.md) | Gate policy, GitHub, GitLab, artifacts, exit handling |
| [Contributing](CONTRIBUTING.md) | Setup, change placement, verification, pull requests |
| [Security policy](SECURITY.md) | Reporting a vulnerability |

## Development

```bash
npm ci
npm test
node dist/cli.js review --verify-only
```

`npm test` builds the project, runs the core self-check suite, and validates every
enabled language pack. `npm run smoke` packs the project, installs the tarball into a
clean repository, and exercises the public binary.

## License

PowerShot is available under the [Apache License 2.0](LICENSE).
