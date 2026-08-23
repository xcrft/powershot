# Contributing

Thanks for improving PowerShot. The project values small changes with explicit
behavioral evidence over broad rewrites.

## Set up

PowerShot requires Node.js 24 or newer.

```bash
git clone https://github.com/xcrft/powershot.git
cd powershot
npm ci
npm test
```

Run the CLI from the build output:

```bash
npm run build
node dist/cli.js --help
```

## Find the right module

- CLI parsing, commands, and report publication belong in `src/cli/`.
- Review-stage orchestration belongs in `src/review.ts`.
- Deterministic checks belong in `src/verifiers/`.
- Language grammar data belongs in `src/lang/`.
- Output-only transformations belong in `src/report/`.
- Completion semantics belong in `src/manifest.ts`.

Read [docs/architecture.md](docs/architecture.md) before moving a boundary or adding a
new one. Prefer a deep module with a small interface over another pass-through wrapper.

## Verify a change

```bash
npm run build
npm test
node dist/cli.js review --verify-only
```

For packaging or CLI entrypoint changes, also run:

```bash
npm run smoke
```

The smoke test packs the project, installs that tarball into an empty repository, and
exercises the public `psh` binary. Do not commit generated `dist/` files.

## Pull requests

- Keep one behavioral or architectural concern per pull request.
- Add a positive and a negative test for a verifier change.
- Update README or `docs/` when the user-facing contract changes.
- State what was verified and what could not be exercised locally.
- Preserve the distinction between a clean review and an incomplete review.

CI integration guidance and copy-paste examples live in [docs/ci.md](docs/ci.md).
