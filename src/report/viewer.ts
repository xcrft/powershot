import type { Finding } from '#app/types.js'
import { modeNote, noFindingsLabel, scopeLine, type ReviewSummary } from './summary.js'

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function viewer(findings: Finding[], meta: ReviewSummary & {
  id: string
  target: string
  started: string
}): string {
  const verified = findings.filter((f) => f.class === 'verified').length
  const incomplete = meta.state !== 'complete'
  const scope = scopeLine(meta)
  const mode = modeNote(meta)
  const warning = incomplete
    ? '<div class="warning"><strong>This review is ' + escape(meta.state) + ' — not a verdict.</strong>' +
      (meta.notLookedAt.length > 0
        ? '<ul>' + meta.notLookedAt.map((reason) => '<li>' + escape(reason) + '</li>').join('') + '</ul>'
        : '') + '</div>'
    : ''
  const context = scope || mode || (meta.scopeDetails?.length ?? 0) > 0
    ? '<div class="coverage">' +
      (scope ? '<strong>' + escape(scope) + '</strong>' : '') +
      (mode ? '<p>' + escape(mode) + '</p>' : '') +
      ((meta.scopeDetails?.length ?? 0) > 0
        ? '<details><summary>' + (meta.coverage === 'portable' ? 'Coverage details' : 'Review scope') + '</summary><ul>' +
          meta.scopeDetails!.map((detail) => '<li>' + escape(detail) + '</li>').join('') +
          '</ul></details>'
        : '') + '</div>'
    : ''
  const verdict = findings.length === 0
    ? '<p class="none">' +
      (incomplete ? 'No findings from what completed.' : escape(noFindingsLabel(meta)) + '.') + '</p>'
    : ''
  const rows = findings
    .map((f) => {
      const frame = f.frame
        ? '<pre class="frame">' +
          f.frame.lines
            .map((l, i) => {
              const n = f.frame!.firstLine + i
              const mark = n === f.line ? ' target' : ''
              return '<span class="ln' + mark + '">' + String(n).padStart(4) + '</span> ' + escape(l)
            })
            .join('\n') +
          '</pre>'
        : ''
      return `<article class="f ${f.class}" data-check="${escape(f.check)}" data-sev="${f.severity}">
  <header><span class="sev ${f.severity}">${f.severity}</span>
    <span class="check">${escape(f.check)}</span>
    <span class="conf">${f.confidence}</span>
    <span class="loc">${escape(f.file)}:${f.line}</span>
    <span class="act"><button data-away="${escape(f.check)}|${escape(f.file)}|${f.line}">put away</button></span></header>
  <p class="title">${escape(f.title)}</p>
  ${frame}
  ${f.evidence ? '<p class="ev">' + escape(f.evidence.oracle) + ': ' + escape(f.evidence.detail) + '</p>' : ''}
  ${f.fix ? '<p class="fix">→ ' + escape(f.fix) + '</p>' : ''}
</article>`
    })
    .join('\n')

  return `<!doctype html>
<meta charset="utf-8">
<title>PowerShot ${escape(meta.id)}</title>
<style>
  :root { color-scheme: light dark;
    --bg:#0a0e13; --panel:#111823; --ink:#e8eef4; --muted:#8e9bab; --line:#1e2a37;
    --red:#ff6a5e; --steel:#5ab0e6; --amber:#f0a94a; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#e9edf1; --panel:#fff; --ink:#0d141c; --muted:#5a6675; --line:#d2dae2;
      --red:#d4302a; --steel:#1f6fa6; --amber:#b06f12; } }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 ui-sans-serif,system-ui,sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:32px 24px 80px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .meta { color:var(--muted); font-family:ui-monospace,monospace; font-size:.8rem; margin-bottom:24px; }
  .bar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  button { font:inherit; font-size:.8rem; background:var(--panel); color:var(--ink);
    border:1px solid var(--line); border-radius:6px; padding:5px 11px; cursor:pointer; }
  button[aria-pressed=true] { border-color:var(--steel); color:var(--steel); }
  .f { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--steel);
    border-radius:8px; padding:14px 18px; margin-bottom:14px; }
  .f.judged { border-left-color:var(--red); }
  header { display:flex; gap:10px; align-items:center; flex-wrap:wrap;
    font-family:ui-monospace,monospace; font-size:.74rem; margin-bottom:8px; }
  .sev { text-transform:uppercase; font-weight:700; }
  .sev.critical,.sev.high { color:var(--red); } .sev.medium { color:var(--amber); }
  .sev.low,.sev.info { color:var(--muted); }
  .check { color:var(--steel); } .conf,.loc { color:var(--muted); } .loc { margin-left:auto; }
  .title { margin:0 0 10px; font-weight:600; }
  .frame { background:var(--bg); border:1px solid var(--line); border-radius:6px;
    padding:10px 12px; overflow-x:auto; font:12px/1.65 ui-monospace,monospace; margin:0 0 10px; }
  .ln { color:var(--muted); } .ln.target { color:var(--red); font-weight:700; }
  .ev { color:var(--muted); font-size:.85rem; margin:0 0 6px; }
  .fix { color:var(--amber); font-size:.85rem; margin:0; }
  .none { color:var(--muted); }
  .warning { border:1px solid var(--amber); border-radius:6px; padding:10px 14px; margin:0 0 18px; }
  .warning ul { margin:6px 0 0; }
  .coverage { border:1px solid var(--steel); border-radius:6px; padding:10px 14px; margin:0 0 18px; }
  .coverage ul { margin:6px 0 0; }
  .f.put-away { opacity:.4; }
  .f.put-away .title { text-decoration:line-through; }
  .act { margin-left:8px; }
  .act button { font-size:.7rem; font-family:ui-monospace,monospace; padding:2px 7px; color:var(--muted);
    background:transparent; }
  .act button:hover { color:var(--ink); border-color:var(--steel); }
</style>
<div class="wrap">
  <h1>PowerShot</h1>
  <p class="meta">${escape(meta.target)} · ${escape(meta.started.slice(0, 19).replace('T', ' '))} · session ${escape(meta.id)}<br>
    ${findings.length} finding(s) — ${verified} verified, ${findings.length - verified} judged</p>
  ${warning}
  ${verdict}
  ${context}
  <div class="bar">
    <button data-filter="all" aria-pressed="true">all</button>
    <button data-filter="verified" aria-pressed="false">verified</button>
    <button data-filter="judged" aria-pressed="false">judged</button>
    <button id="show-away" aria-pressed="false">show put away</button>
  </div>
  ${findings.length === 0 ? '' : rows}
</div>
<script>
  // Putting a finding away is per-reader and per-browser on purpose: this page is a
  // file, often attached to a ticket, and one reader's triage is not a fact about the
  // review that belongs in everyone else's copy of it.
  const KEY = 'powershot:away:' + ${JSON.stringify(JSON.stringify(meta.id))}
  const away = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'))
  let showAway = false

  function paint() {
    document.querySelectorAll('.f').forEach((el) => {
      const id = el.querySelector('[data-away]').dataset.away
      const isAway = away.has(id)
      el.classList.toggle('put-away', isAway)
      el.dataset.putAway = isAway ? '1' : '0'
      if (isAway && !showAway) el.style.display = 'none'
      if (!isAway) el.style.display = ''
      el.querySelector('[data-away]').textContent = isAway ? 'restore' : 'put away'
    })
    const btn = document.getElementById('show-away')
    btn.setAttribute('aria-pressed', String(showAway))
    btn.textContent = away.size
      ? (showAway ? 'hide put away' : 'show put away (' + away.size + ')')
      : 'show put away'
  }

  document.querySelectorAll('[data-away]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.away
      away.has(id) ? away.delete(id) : away.add(id)
      localStorage.setItem(KEY, JSON.stringify([...away]))
      paint()
    })
  })
  document.getElementById('show-away').addEventListener('click', () => {
    showAway = !showAway
    paint()
    if (showAway) document.querySelectorAll('.f.put-away').forEach((el) => { el.style.display = '' })
  })
  paint()

  document.querySelectorAll('button[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      const want = b.dataset.filter
      document.querySelectorAll('button[data-filter]').forEach((o) =>
        o.setAttribute('aria-pressed', String(o === b)))
      document.querySelectorAll('.f').forEach((f) => {
        f.style.display = want === 'all' || f.classList.contains(want) ? '' : 'none'
      })
    })
  })
</script>
`
}
