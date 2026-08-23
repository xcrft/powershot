const BODY = `## Reviewing a change with PowerShot

Before committing, before opening a pull request, or whenever asked to check a diff:

\`\`\`bash
psh review --verify-only
\`\`\`

This runs deterministic checks only — no model, no tokens. Every finding came from an
oracle (the TypeScript checker, the package manifest, the reference graph, the
pre/post AST), so treat it as fact rather than opinion.

Read the confidence on each finding:

- **proven** — the oracle answered exactly. Fix it.
- **firm** — a heuristic with judgement left in it. Read the code before acting.

For a whole branch: \`psh review --verify-only --from main --to HEAD\`.
For files with no git history: \`psh scan src/\`.

### Do the judging yourself

You already have a model, so do not spend a second one. Ask for the judging work and
perform it:

\`\`\`bash
psh delegate > /tmp/brief.md
\`\`\`

Follow that brief, write your findings as the JSON array it specifies, then merge them
back into the report:

\`\`\`bash
psh review --verify-only --absorb /tmp/findings.json
\`\`\`

### What it looks for

Failure modes that machine-written code makes common: APIs that do not exist, helpers
the repository already has, dependencies that were never installed, guards lost in a
rewrite, error handling that discards the error, tests that assert nothing, an
expectation edited to match new output, and callers left behind by a signature change.
`

export type AgentTarget = {
  name: string
  path: string
  serves: string
  render: () => string
}

export const TARGETS: AgentTarget[] = [
  {
    name: 'agents',
    path: 'AGENTS.md',
    serves: 'Codex, Cursor, Copilot, Gemini CLI, Grok, Windsurf, Zed, Aider, and others reading the AGENTS.md standard',
    render: () => '# Agent instructions\n\n' + BODY,
  },
  {
    name: 'claude',
    path: '.claude/skills/powershot-review/SKILL.md',
    serves: 'Claude Code, and Grok (which also reads .claude/)',
    render: () =>
      [
        '---',
        'name: powershot-review',
        'description: Review the current change for the failure modes of machine-written code — hallucinated APIs, helpers that already exist, guards lost in a rewrite, tests that assert nothing. Use before committing, before opening a pull request, or when asked to check a diff. Deterministic and costs no tokens.',
        '---',
        '',
        '# PowerShot review',
        '',
        BODY.replace('## Reviewing a change with PowerShot\n\n', ''),
      ].join('\n'),
  },
  {
    name: 'copilot',
    path: '.github/copilot-instructions.md',
    serves: 'GitHub Copilot, for repositories not using AGENTS.md',
    render: () => '# Copilot instructions\n\n' + BODY,
  },
  {
    name: 'cursor',
    path: '.cursor/rules/powershot.mdc',
    serves: 'Cursor, for repositories not using AGENTS.md',
    render: () =>
      ['---', 'description: Reviewing a change with PowerShot', 'alwaysApply: false', '---', '', BODY].join('\n'),
  },
]

export function findTarget(name: string): AgentTarget | undefined {
  return TARGETS.find((t) => t.name === name)
}
