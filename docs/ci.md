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

| Exit | Meaning | Recommended CI handling |
|---:|---|---|
| `0` | Complete, no findings | Pass |
| `1` | Complete, findings reported | Pass or fail according to repository policy |
| `2` | Invalid command or Git input | Fail |
| `3` | Partial or failed review | Fail |
| `130` | Interrupted | Fail or retry |

## GitHub Action

The action runs one review, adds a job summary, uploads SARIF, and can maintain one
pull-request comment.

```yaml
name: PowerShot

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - uses: xcrft/powershot@v1
        with:
          verify-only: 'true'
          comment: 'true'
          fail-on-findings: 'true'
```

The major tag follows compatible `1.x` releases. Pin a full commit SHA in a protected
required workflow when immutable dependencies are required. The copy-paste version
lives at [`examples/github-actions/action.yml`](../examples/github-actions/action.yml).

### Action inputs

| Input | Default | Purpose |
|---|---|---|
| `verify-only` | `true` | Run deterministic checks without a model |
| `anthropic-api-key` | empty | Enable configured model judges |
| `min-severity` | `low` | Filter findings below a severity |
| `checks` | empty | Select comma-separated check ids |
| `comment` | `true` | Maintain a pull-request comment |
| `fail-on-findings` | `false` | Turn a complete finding verdict into a failed job |
| `approve` | `false` | Approve only a complete, clean review |

The outputs are `findings` and `complete`. `complete` is the important one when a
later job decides whether to publish or deploy.

## Direct CLI on GitHub Actions

Use the CLI when the workflow needs custom artifact handling or when PowerShot is one
step inside a larger quality job. The complete example is
[`examples/github-actions/cli.yml`](../examples/github-actions/cli.yml).

The core pattern is:

```bash
npm install --global --ignore-scripts @0xcraft/powershot@1.0.0

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

The CLI's `codequality` format is accepted by GitLab's Code Quality report. Use a full
clone or fetch both merge-request SHAs, then preserve the CLI status separately from
the redirected report:

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
