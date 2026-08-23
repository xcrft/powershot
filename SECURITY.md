# Security

## Reporting

Report a vulnerability through [GitHub's private advisory form](https://github.com/xcrft/powershot/security/advisories/new).
Please do not open a public issue for one. Expect an acknowledgement within three
working days.

## What PowerShot treats as untrusted

The code under review is attacker-controlled input. So is everything a model returns
about it. Both are handled as data, never as instruction:

- **Repository reads** go through one policy (`src/fspolicy.ts`), applied at every
  ingress — git diff, untracked files, the scanner, the compiler project, and the
  tools a judge can call. Paths that leave the repository are refused, symlinks are
  not followed, and `.git`, `.env`, key material and credential files are denied by
  path segment.
- **Git refs** are validated before reaching a git command. An argument beginning with
  `-` is an option to git however it was quoted, so a ref is resolved with `rev-parse`
  before it is used.
- **Model tools** are read-only: file read, grep, and reference lookup. There is no
  shell, no write, and no network in the tool surface.
- **Model output** never executes and is never auto-applied. Suggestions are text a
  human commits. Control characters are stripped from every rendered field, including
  the path, and the markdown renderer escapes prose so a title cannot end the fence it
  sits in or rewrite the link beside it — that output is posted as a PR comment.
- **Suppression and policy** are read from the base ref when a review has one, so a
  change cannot dismiss its own findings or relax the gate that is judging it.

## What a clean result means

Exit 0 means every selected file was reviewed by every check that could run. It does
not mean the code is safe. A run that could not look at something reports state
`partial` or `failed` in its manifest and exits non-zero; see `--format manifest`.

Do not treat PowerShot as a security scanner. Its security judge is model-based,
opt-in, and unmeasured against a security corpus.

## What the reviewed repository is not allowed to control

A repository under review must not be able to choose how it is reviewed.

- **`.env` may supply a credential and nothing else.** Only `*_API_KEY` is taken from
  it; a destination like `ANTHROPIC_BASE_URL` or a behaviour knob like
  `POWERSHOT_TIMEOUT_MS` is refused and named on stderr. A credential from a hostile
  repository only makes calls fail; a destination decides who receives the diff.
  The file is skipped entirely when `CI` is set, and never overrides the environment.
- **pyright comes from `PATH`, never from the repository's `node_modules`.** Resolving
  it there let a repository supply the binary that reviews it.
- **The dismissal list is read from the base ref** when a review has one.
- **The judge cache lives outside the repository** for a gated review, under the
  running user's cache directory and keyed by repository. An entry in the tree would
  let a change commit "this content has no findings" and never be judged; reading it
  from the base ref instead would have cost reuse between pushes, which is the one
  thing the cache is for. `POWERSHOT_CACHE_DIR` points it somewhere CI can restore.
- **`powershot.config.json` is read from the base ref** for the same reason.
- **A tsconfig above the repository is not used**, and the compiler project's symbol
  index and reference lookups re-check containment: the project glob follows symlinked
  directories, so having been loaded is not proof of where a file is.
- **A check with no oracle behind it is skipped and reported**, never recorded as run
  and satisfied. Pyright being installed is its own capability, so a repository with a
  tsconfig and some Python in it cannot satisfy the Python check through the
  TypeScript checker.

## Secrets in CI

The Action needs no secret to run its deterministic half. `anthropic-api-key` is only
required for the judges. Do not run PowerShot with a write token on `pull_request_target`
against untrusted forks.
