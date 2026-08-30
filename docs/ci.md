# CI integration

PowerShot has two CI surfaces:

- the composite GitHub Action for the shortest GitHub setup;
- the `psh` CLI for GitHub, GitLab, and any runner that can execute Node.js 24.

Use the composite action for GitHub-native reporting or install the versioned npm
package when the CLI needs to fit into another CI system.

## Choose a policy first

There are two independent decisions:

1. Must the review complete? Usually yes. Exit `2` or `3` should always fail a gate.
2. Do findings block the change? Set this per repository. Exit `1` is a complete
   verdict with findings, not an engine failure.

A completed verdict has a separate coverage level. `full` means every applicable
configured oracle ran. `portable` means every self-contained oracle ran while missing
compiler/reference depth was named. Set `"coverage": "strict"` in
`powershot.config.json` when portable depth must become exit `3` instead.

| Exit | Meaning | Recommended CI handling |
|---:|---|---|
| `0` | Complete, no findings | Pass |
| `1` | Complete, findings reported | Pass or fail according to repository policy |
| `2` | Invalid command or Git input | Fail |
| `3` | Partial or failed review | Fail |
| `130` | Interrupted | Fail or retry |

## GitHub Action

The action runs one review, adds a job summary, uploads SARIF when enabled, and can
maintain one pull-request comment. Its opt-in inline mode posts a bounded batched
review on changed lines.

```yaml
name: PowerShot

on:
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  review:
    runs-on: ubuntu-24.04
    steps:
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

Portable coverage deliberately needs no repository install. This keeps fork and
private-monorepo pull requests free of registry credentials while still running each
declared language's syntax-backed oracles. When a trusted job already has dependencies,
PowerShot uses the available declarations and can reach `full` coverage. Do not pass a
private package token into a pull-request job merely to enrich review depth.

PowerShot finds nested `tsconfig.json` and `tsconfig.*.json` files along changed-file
ancestor chains; the workflow does not list projects. Python local-module discovery is
bounded the same way. Foreign-language grammars run in disposable per-language workers
and bounded batches, so all declared languages can coexist in one monorepo review.

Set `upload-sarif: 'false'` and omit `security-events: write` when GitHub code scanning
is unavailable or the workflow should not publish SARIF.

`comment: 'true'` maintains one summary through a hidden marker scoped to the caller's
workflow file and job. Reruns update only that exact `github-actions[bot]` comment, so
another workflow or job using the same bot identity is left alone. Each candidate also
records its pull-request head. A new head gets a new candidate, which means an old run
never patches or retires the current head's comment. The first scoped run replaces the
newest unmarked legacy `## PowerShot` summary from v1.1.2 or older without claiming the
ambiguous legacy comment through `PATCH`.

The comment leads with actionable deterministic and `firm` agent finding counts,
effective severity threshold, review mode, and reviewed/changed file ratio and check
count. Tentative agent suspicions are counted as withheld but are not rendered as
findings. Portable gaps and files outside parser coverage stay visible under a
collapsed coverage section without filling the timeline with paths. Source links are
pinned to the reviewed head. The generated `powershot.json` retains tentative output,
and `powershot.manifest.json` keeps the per-file accounting for workflows that want
to persist it as an artifact.

For a `pull_request` from a fork, GitHub gives the workflow token read-only pull-request
permissions. PowerShot still runs and writes the complete report to the job summary,
but skips summary comments, inline comments, and approval because those operations
require a write-capable token.

PowerShot checks the target head throughout reconciliation and removes its own
just-created candidate if it observes a changed head. Simultaneous same-head runs
relist and converge on one scoped candidate when they complete. Keep the example's
`concurrency` block to reduce overlap and canceled stale work. GitHub's issue-comment
REST API has no atomic create-if-absent operation, and cancellation cannot stop a REST
request already in flight, so concurrency reduces but cannot eliminate that window.

`inline-comments: 'true'` requires `pull-requests: write`. It publishes at most ten
findings as one review. Only deterministic `verified` findings with `proven`
confidence, severity `medium` or higher, and a GitHub-confirmed added line qualify.
Findings on context lines or files whose patch GitHub omitted stay in the full report.
Reruns preserve exact bot comments, create only missing comments, and remove stale
PowerShot inline copies without replies. Human comments and replied-to discussions
are never modified.

The major tag follows compatible `1.x` releases. Pin a full commit SHA in a protected
required workflow when immutable dependencies are required. The copy-paste version
lives at [`examples/github-actions/action.yml`](../examples/github-actions/action.yml).

### Action inputs

| Input | Default | Purpose |
|---|---|---|
| `verify-only` | `true` | Run deterministic checks without a model |
| `anthropic-api-key` | empty | Supply `ANTHROPIC_API_KEY` when the configured provider is Anthropic |
| `glm-api-key` | empty | Supply `GLM_API_KEY` when the configured provider is GLM |
| `min-severity` | `low` | Filter findings below a severity |
| `checks` | empty | Select comma-separated check ids |
| `upload-sarif` | `true` | Upload actionable findings to GitHub code scanning |
| `comment` | `true` | Maintain a pull-request comment |
| `inline-comments` | `false` | Post up to ten proven verified findings as one inline review |
| `fail-on-findings` | `false` | Fail when an actionable finding is published |
| `approve` | `false` | Approve only a complete, actionable-clean, full-coverage review |

The outputs are `findings`, `complete`, and `coverage`. `findings` counts the
actionable results published to SARIF, not withheld tentative agent suspicions. Gate
infrastructure on `complete`; use `coverage == 'full'` for decisions that require
semantic depth.

## Direct CLI on GitHub Actions

Use the CLI when the workflow needs custom artifact handling or when PowerShot is one
step inside a larger quality job. The complete example is
[`examples/github-actions/cli.yml`](../examples/github-actions/cli.yml).

The core pattern is:

```bash
npm install --global --ignore-scripts @0xcraft/powershot@1.1.2

STATUS=0
psh review --verify-only \
  --from "$BASE" --to HEAD \
  --report sarif=powershot.sarif \
  --report markdown=powershot.md \
  --format compact || STATUS=$?

case "$STATUS" in
  0) exit 0 ;;
  1) exit 1 ;; # change to 0 when findings are advisory
  *) exit "$STATUS" ;;
esac
```

Do not pipe the review directly into another command without preserving its exit code.
Do not run once per report: repeated `--report` flags create all artifacts from the
same verdict.

## GitLab Code Quality

The CLI's `codequality` format is accepted by GitLab's Code Quality report and
withholds tentative agent suspicions. Use a full clone or fetch both merge-request
SHAs, then preserve the CLI status separately from the redirected report:

```bash
STATUS=0
node "$POWERSHOT/dist/cli.js" review --verify-only \
  --from "$CI_MERGE_REQUEST_DIFF_BASE_SHA" \
  --to "$CI_COMMIT_SHA" \
  --format codequality > gl-code-quality-report.json || STATUS=$?

test "$STATUS" -le 1 || exit "$STATUS"
test "$STATUS" -eq 0
```

See [`examples/gitlab/.gitlab-ci.yml`](../examples/gitlab/.gitlab-ci.yml) for the job
and artifact declaration.

## CI checklist

- Use Node.js 24 or newer.
- Fetch enough Git history for both endpoints of the review range.
- Use immutable base and head SHAs where the CI provider exposes them.
- Run `--verify-only` as the fast required check; add model judges only where their
  cost and latency are intentional.
- Treat exit `2`, `3`, and `130` as infrastructure or completeness failures.
- Read the manifest or Action `coverage` output before treating portable depth as full.
- Generate every report from one invocation.
- Publish the Markdown report for humans and SARIF or Code Quality for annotations.
- Pin the PowerShot source version in protected workflows.
- Keep `powershot.config.json` in review so policy changes are visible.

## Local parity

Run the same deterministic gate before pushing:

```bash
node dist/cli.js review --verify-only --from main --to HEAD
```

For an uncommitted workspace, omit the range:

```bash
node dist/cli.js review --verify-only
```
