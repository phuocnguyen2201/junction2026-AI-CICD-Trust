import fs from 'node:fs';
import path from 'node:path';
import { Git } from './git.ts';
import { loadCard, isAnswered } from './card.ts';
import { appendRun, loadRuns, loadStage, stateDir, type RunEntry, type StageRecord } from './state.ts';
import { trustData } from '../commands/trust.ts';
import type { CheckResult, Finding } from './types.ts';

// Local HTML dashboard, rewritten after every run: .preguard/reports/index.html (+ a snapshot per run in runs/).
// Self-contained (no network), escapes every string that came from code, tools or the AI.

const REPORT_DIR = '.preguard/reports';
const KEEP_SNAPSHOTS = 30;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

const STATUS = {
  pass: ['pass', 'Pass'],
  fail: ['fail', 'Fail'],
  warn: ['warn', 'Warning'],
  not_run: ['idle', 'Not run'],
} as const;
const VERDICT: Record<string, [string, string]> = { green: ['pass', 'Ready'], yellow: ['warn', 'Ready with notes'], red: ['fail', 'Not ready'] };

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

interface Data {
  repo: string;
  branch: string;
  cardId: string | null;
  cardTitle: string | null;
  decisions: { id: string; question: string; owner: string; answer: string | null }[];
  record: StageRecord | null;
  verdict: { status: string; fresh: boolean; at: string } | null;
  track: string | null;
  trust: ReturnType<typeof trustData> | null;
  trustError: string | null;
  runs: RunEntry[];
  generated: string;
}

function gather(root: string, cardId: string | null): Data {
  const git = new Git(root);
  const review = loadStage(root, cardId, 'review');
  const check = loadStage(root, cardId, 'check');
  const record = [review, check].filter(Boolean).sort((a, b) => b!.started_at.localeCompare(a!.started_at))[0] ?? null;
  const ready = readJson(path.join(stateDir(root, cardId), 'ready.json'));
  const card = cardId ? loadCard(root, cardId).card : null;
  let trust: Data['trust'] = null;
  let trustError: string | null = null;
  try {
    trust = trustData(root);
  } catch (e) {
    trustError = (e as Error).message;
  }
  const md = cardId ? path.join(root, REPORT_DIR, `${cardId}.md`) : null;
  const trackLine = md && fs.existsSync(md) ? /\*\*Track record\*\* for \*([^*]+)\* changes in this repo: (.*)\.$/m.exec(fs.readFileSync(md, 'utf8')) : null;
  return {
    repo: path.basename(root),
    branch: git.branch(),
    cardId,
    cardTitle: card?.title ?? null,
    decisions: (card?.open_decisions ?? []).map((d) => ({ id: d.id, question: d.question, owner: d.owner_role, answer: isAnswered(d.answer) ? d.answer : null })),
    record,
    verdict: ready ? { status: ready.status, fresh: ready.tree === git.headTree() && !git.isDirty(), at: ready.at } : null,
    track: trackLine ? `${trackLine[1]}: ${trackLine[2]}` : null,
    trust,
    trustError,
    runs: loadRuns(root),
    generated: new Date().toISOString(),
  };
}

// ---------- page ----------

const CSS = `
:root{--bg:#f4f6f8;--surface:#fff;--ink:#17202b;--muted:#5b6777;--line:#dbe1e8;--accent:#2457a8;--accent-soft:#e6eefa;
--pass:#1b7a45;--pass-bg:#e1f3e8;--warn:#966100;--warn-bg:#fbefd6;--fail:#b3261e;--fail-bg:#fbe3e0;--idle:#7a8592;--idle-bg:#eceff3;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--surface:#161d25;--ink:#e3e8ee;--muted:#97a3b2;--line:#29343f;--accent:#7cb0f2;--accent-soft:#1a2a3d;
--pass:#5cc98a;--pass-bg:#15301f;--warn:#e7b04e;--warn-bg:#342812;--fail:#f2847b;--fail-bg:#391b18;--idle:#7d8a98;--idle-bg:#1d252e;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans)}
.wrap{max-width:1120px;margin:0 auto;padding:28px max(16px,env(safe-area-inset-right)) 56px max(16px,env(safe-area-inset-left));display:grid;gap:28px}
.wrap>*,.hero>*,.two>*,.tiles>*,section{min-width:0}h1{overflow-wrap:anywhere}
h1{font-size:24px;margin:0;font-weight:650;letter-spacing:-.01em}h2{font-size:16px;margin:0 0 12px;font-weight:650}
.meta{color:var(--muted);font:12.5px var(--mono);display:flex;flex-wrap:wrap;gap:4px 16px}.meta b{color:var(--ink);font-weight:500}
.eyebrow{font:600 11px var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:18px}
.hero{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,2fr);gap:16px}
.verdict{display:grid;gap:10px;align-content:start}.verdict .big{font-size:26px;font-weight:700;display:flex;align-items:center;gap:10px}
.dot{width:14px;height:14px;border-radius:50%;flex:none}.dot.pass{background:var(--pass)}.dot.warn{background:var(--warn)}.dot.fail{background:var(--fail)}.dot.idle{background:var(--idle)}
.why{color:var(--muted)}.track{font-size:13px;border-left:3px solid var(--accent);padding:6px 10px;background:var(--accent-soft);border-radius:0 4px 4px 0}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.tile{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px;display:grid;gap:2px}
.tile .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}.tile .n small{font-size:14px;color:var(--muted);font-weight:600}.tile .l{color:var(--muted);font-size:12.5px}
.pill{display:inline-block;font:600 11px var(--mono);letter-spacing:.03em;text-transform:uppercase;padding:3px 7px;border-radius:4px;white-space:nowrap}
.pill.pass{color:var(--pass);background:var(--pass-bg)}.pill.warn{color:var(--warn);background:var(--warn-bg)}.pill.fail{color:var(--fail);background:var(--fail-bg)}.pill.idle{color:var(--idle);background:var(--idle-bg)}
.scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font:600 11px var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--muted);white-space:nowrap}tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}code,.mono{font:12.5px var(--mono)}.muted{color:var(--muted)}
.ev{font:12px/1.45 var(--mono);color:var(--muted);overflow-wrap:anywhere;margin-top:3px}a{color:var(--accent)}
.sev{font:700 11px var(--mono);text-transform:uppercase}.sev.high{color:var(--fail)}.sev.medium{color:var(--warn)}.sev.low{color:var(--muted)}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
.bars{display:grid;gap:12px}.bar-row{display:grid;grid-template-columns:150px minmax(0,1fr) 54px;gap:10px;align-items:center}
.track-bg{height:14px;background:var(--idle-bg);border-radius:3px;position:relative;overflow:hidden}.fill{height:100%;border-radius:3px}
.lb{position:relative;height:10px;background:var(--idle-bg);border-radius:3px;min-width:120px}.lb .fill{background:var(--accent)}.lb .mark{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.55}
.big-change{font-size:20px;font-weight:700;margin-top:4px}.good{color:var(--pass)}.bad{color:var(--fail)}
.stack{display:flex;height:12px;border-radius:3px;overflow:hidden;background:var(--idle-bg);min-width:140px}.stack span{display:block;height:100%}
.acc{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.impact{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.impact div{min-width:0}
details summary{cursor:pointer;color:var(--accent);font-size:13px}
footer{color:var(--muted);font-size:12.5px}
@media (max-width:820px){.hero,.two,.impact{grid-template-columns:minmax(0,1fr)}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.acc{grid-template-columns:minmax(0,1fr)}.bar-row{grid-template-columns:110px minmax(0,1fr) 46px}}
`;

function checksTable(results: CheckResult[]): string {
  const rows = results
    .map((r) => {
      const [cls, label] = STATUS[r.status];
      return `<tr><td>${esc(r.title)}</td><td><span class="pill ${cls}">${label}</span></td><td>${esc(r.summary)}</td><td class="num">${secs(r.ms)}</td></tr>`;
    })
    .join('');
  return `<div class="scroll"><table><thead><tr><th>Check</th><th>Result</th><th>Details</th><th class="num">Time</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function findingsTable(findings: Finding[]): string {
  if (!findings.length) return `<p class="muted">No open findings.</p>`;
  const order = { high: 0, medium: 1, low: 2 };
  const rows = [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map(
      (f) =>
        `<tr><td><span class="sev ${f.severity}">${f.severity}</span></td><td class="mono">${esc(f.file)}:${f.line}</td><td>${esc(f.reason)}<div class="ev">${esc(f.evidence)}</div>${f.source_url ? `<div class="ev">source: <a href="${esc(f.source_url)}" rel="noreferrer">${esc(f.source_url)}</a></div>` : ''}</td><td>${f.origin === 'ai' ? 'AI' : 'check'}</td></tr>`,
    )
    .join('');
  return `<div class="scroll"><table><thead><tr><th>Severity</th><th>Where</th><th>Reason and evidence</th><th>Found by</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function trustSection(t: NonNullable<Data['trust']>): string {
  const b = t.periods.before;
  const w = t.periods.with;
  const barRow = (label: string, rate: number | null, color: string) =>
    `<div class="bar-row"><span>${esc(label)}</span><div class="track-bg"><div class="fill" style="width:${Math.round((rate ?? 0) * 100)}%;background:${color}"></div></div><span class="num mono">${pct(rate)}</span></div>`;
  const fb = b.rate === null ? null : 1 - b.rate;
  const fw = w.rate === null ? null : 1 - w.rate;
  const change = fb && fw !== null ? Math.round(((fb - fw) / fb) * 100) : null;
  const adoption = t.adopted
    ? `<div class="card"><div class="eyebrow">Before vs with Pre-PR Guard · adopted ${t.adopted.toISOString().slice(0, 10)}</div><h2 style="margin-top:6px">Task success rate</h2>
<div class="bars">${barRow(`before (${b.settled} tasks)`, b.rate, 'var(--idle)')}${barRow(`with Pre-PR Guard (${w.settled})`, w.rate, 'var(--pass)')}</div>
<div class="big-change ${change !== null && change > 0 ? 'good' : 'bad'}">Failure rate ${pct(fb)} → ${pct(fw)}${change !== null ? ` (${change > 0 ? `${change}% fewer` : `${-change}% more`} failed tasks)` : ''}</div>
<p class="muted" style="margin:6px 0 0">Failed = reverted, or a follow-up fix touched its files within ${t.rules.trust.window_days} days. Before: ${b.reverted} reverted, ${b.followUp} fixed. With: ${w.reverted} reverted, ${w.followUp} fixed.</p></div>`
    : `<div class="card"><h2>Task success rate</h2><p class="muted">No adoption date found (the commit that added .preguard/rules.yml), so there is no before/after split.</p></div>`;
  const a = t.accuracy;
  const acc = `<div class="card"><div class="eyebrow">Pre-PR Guard's own accuracy</div><h2 style="margin-top:6px">How often a verdict was wrong</h2>
<div class="acc"><div class="tile"><span class="n">${a.falseGreens.length}<small> / ${a.greens}</small></span><span class="l">🟢 reports that later failed (${pct(a.greens ? a.falseGreens.length / a.greens : null)})</span></div>
<div class="tile"><span class="n">${a.yellowFailed}<small> / ${a.yellows}</small></span><span class="l">🟡 reports that later failed</span></div>
<div class="tile"><span class="n">${a.bypassedFailed.length}<small> / ${a.bypassed}</small></span><span class="l">bypassed 🔴 merged anyway that failed</span></div></div>
${a.falseGreens.length || a.bypassedFailed.length ? `<p class="muted" style="margin:10px 0 0">Tasks to learn from: ${[...a.falseGreens, ...a.bypassedFailed].map(esc).join(', ')}</p>` : ''}</div>`;
  const bound = t.rules.trust.required_lower_bound;
  const rows = t.byCategory
    .map((c) => {
      const prev = t.beforeByCategory.get(c.category);
      const [cls, label] = c.trust === 'earned' ? ['pass', 'Earned'] : c.trust === 'not_earned' ? ['fail', 'Not earned'] : ['warn', 'Building'];
      const lb = Math.round((c.lowerBound ?? 0) * 100);
      return `<tr><td>${esc(c.category)}</td><td class="num">${pct(prev?.rate)}</td><td class="num">${pct(c.rate)}</td><td class="num">${c.settled}</td>
<td><div class="lb" title="95% lower bound ${lb}% (needs ${Math.round(bound * 100)}%)"><div class="fill" style="width:${lb}%"></div><div class="mark" style="left:${Math.round(bound * 100)}%"></div></div><div class="ev">${lb}% · needs ${Math.round(bound * 100)}%</div></td>
<td><span class="pill ${cls}">${label}</span>${c.trust === 'earned' ? '<div class="ev">fast accept allowed</div>' : c.needed !== null ? `<div class="ev">+${c.needed} successes in a row</div>` : ''}</td></tr>`;
    })
    .join('');
  const table = `<div><h2>Trust per category <span class="muted" style="font-weight:400;font-size:13px">${t.adopted ? 'judged on tasks since adoption' : ''}</span></h2>
<div class="scroll"><table><thead><tr><th>Category</th><th class="num">Before</th><th class="num">Now</th><th class="num">Tasks</th><th>95% lower bound</th><th>Trust</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted" style="margin:8px 0 0">"Earned" needs at least ${t.rules.trust.min_tasks} settled tasks and a 95% lower bound of ${Math.round(bound * 100)}% or more, so a small lucky streak can't earn it. ${t.tasks.filter((x) => x.outcome === 'too_recent').length} recent task(s) are not judged yet.</p></div>`;
  const devRows = t.byDeveloper
    .map((c) => {
      const [cls, label] = c.trust === 'earned' ? ['pass', 'Earned'] : c.trust === 'not_earned' ? ['fail', 'Not earned'] : ['warn', 'Building'];
      const w = (n: number) => (c.settled ? (n / c.settled) * 100 : 0);
      const defects = c.followUp + c.reverted;
      return `<tr><td>${esc(c.category)}</td><td class="num">${c.settled}</td>
<td><div class="stack" title="${c.success} worked perfectly, ${c.followUp} hit a defect, ${c.reverted} reverted"><span style="width:${w(c.success)}%;background:var(--pass)"></span><span style="width:${w(c.followUp)}%;background:var(--warn)"></span><span style="width:${w(c.reverted)}%;background:var(--fail)"></span></div>
<div class="ev">${c.success} perfect · ${c.followUp} defect · ${c.reverted} reverted</div></td>
<td class="num">${pct(c.settled ? defects / c.settled : null)}</td><td class="num"><b>${pct(c.rate)}</b></td><td class="num">${pct(c.lowerBound)}</td>
<td><span class="pill ${cls}">${label}</span>${c.trust !== 'earned' && c.needed !== null ? `<div class="ev">+${c.needed} perfect PRs in a row</div>` : ''}</td></tr>`;
    })
    .join('');
  const devs = `<div><h2>Per developer <span class="muted" style="font-weight:400;font-size:13px">PR = task · all settled history</span></h2>
<div class="scroll"><table><thead><tr><th>Developer</th><th class="num">PRs</th><th>Outcome</th><th class="num">Defect rate</th><th class="num">Trust ratio</th><th class="num">95% lower</th><th>Trust</th></tr></thead><tbody>${devRows}</tbody></table></div>
<p class="muted" style="margin:8px 0 0">Trust ratio = PRs that worked perfectly ÷ settled PRs. A defect = a follow-up fix touched the PR's files within ${t.rules.trust.window_days} days. Use these numbers to choose review depth and pairing, not to rank people: small samples swing a lot.</p></div>`;
  const taskRows = t.tasks
    .slice()
    .reverse()
    .map((x) => {
      const [cls, label] = x.outcome === 'success' ? ['pass', 'success'] : x.outcome === 'too_recent' ? ['idle', 'too recent'] : ['fail', x.outcome === 'reverted' ? 'reverted' : 'follow-up fix'];
      return `<tr><td class="mono">${esc(x.id)}</td><td class="mono">${x.last.toISOString().slice(0, 10)}</td><td>${esc(x.title)}${x.evidence.map((e) => `<div class="ev">${esc(e)}</div>`).join('')}</td><td>${esc(x.author)}</td><td>${esc(x.layers.join(' + ') || 'other')}${x.aiAssisted ? ' · AI' : ''}</td><td>${x.preguard ? esc(x.preguard.status + (x.preguard.bypassed ? ' (bypassed)' : '')) : '<span class="muted">–</span>'}</td><td><span class="pill ${cls}">${label}</span></td></tr>`;
    })
    .join('');
  const tasks = `<details><summary>All ${t.tasks.length} tasks with the commit that proves each outcome</summary><div class="scroll" style="margin-top:10px"><table><thead><tr><th>Task</th><th>Date</th><th>Title and evidence</th><th>Author</th><th>Kind</th><th>Verdict</th><th>Outcome</th></tr></thead><tbody>${taskRows}</tbody></table></div></details>`;
  return `<section><div class="eyebrow">Trust, from git history of ${esc(t.base)}</div><div class="two" style="margin-top:10px">${adoption}${acc}</div></section><section>${table}</section><section>${devs}</section><section>${tasks}</section>`;
}

function runsTable(runs: RunEntry[]): string {
  if (!runs.length) return `<p class="muted">No runs recorded yet.</p>`;
  const rows = runs
    .map((r) => {
      const cls = r.result === 'pass' || r.result === 'green' ? 'pass' : r.result === 'yellow' ? 'warn' : 'fail';
      const label = VERDICT[r.result]?.[1] ?? r.result;
      const f = r.findings;
      return `<tr><td class="mono">${esc(when(r.at))}</td><td>${esc(r.stage)}</td><td class="mono">${esc(r.branch)}</td><td class="mono">${esc(r.card ?? '–')}</td><td><span class="pill ${cls}">${esc(label)}</span></td><td class="num">${f.high}/${f.medium}/${f.low}</td><td class="num">${r.not_run}</td><td class="num">${secs(r.ms)}</td><td>${r.snapshot ? `<a href="${esc(r.snapshot)}">open</a>` : ''}</td></tr>`;
    })
    .join('');
  return `<div class="scroll"><table><thead><tr><th>When (UTC)</th><th>Stage</th><th>Branch</th><th>Card</th><th>Result</th><th class="num">High/med/low</th><th class="num">Not run</th><th class="num">Time</th><th>Snapshot</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderDashboard(d: Data): string {
  const rec = d.record;
  const results = rec?.results ?? [];
  const findings = results.flatMap((r) => r.findings);
  const passed = results.filter((r) => r.status === 'pass').length;
  const ai = results.find((r) => r.id === 'ai_review');
  const impact = results.find((r) => r.id === 'impact');
  const imp = impact && impact.status !== 'not_run' ? (impact.data as Record<string, string> | undefined) : undefined;
  const [vCls, vLabel] = d.verdict?.fresh ? VERDICT[d.verdict.status] : rec ? (results.some((r) => r.status === 'fail') ? ['fail', 'Blocked'] : ['idle', 'No verdict yet']) : ['idle', 'No run yet'];
  const why = d.verdict?.fresh
    ? `Verdict from <code>preguard ready</code> at ${esc(when(d.verdict.at))} UTC.`
    : d.verdict
      ? 'The last verdict was for older code. Run <code>preguard ready</code> again.'
      : rec
        ? `From the last <code>preguard ${esc(rec.stage === 'review_staged' ? 'review --staged' : rec.stage)}</code>. Run <code>preguard ready</code> for a readiness verdict.`
        : 'Run <code>preguard review</code> or <code>preguard ready</code>.';
  const open = d.decisions.filter((x) => !x.answer);
  const tiles = `<div class="tiles">
<div class="tile"><span class="n">${passed}<small> / ${results.length}</small></span><span class="l">checks passed${results.filter((r) => r.status === 'not_run').length ? ` · ${results.filter((r) => r.status === 'not_run').length} not run` : ''}</span></div>
<div class="tile"><span class="n">${findings.length}</span><span class="l">open findings: ${findings.filter((f) => f.severity === 'high').length} high, ${findings.filter((f) => f.severity === 'medium').length} medium, ${findings.filter((f) => f.severity === 'low').length} low</span></div>
<div class="tile"><span class="n">${ai ? (ai.status === 'not_run' ? '–' : ai.findings.length) : '–'}</span><span class="l">AI findings${ai?.status === 'not_run' ? ' (AI not run)' : ai?.data?.dropped ? ` · ${(ai.data.dropped as string[]).length} unproven dropped` : ''}</span></div>
<div class="tile"><span class="n">${open.length}</span><span class="l">open decisions${open.length ? `: ${open.map((x) => esc(x.id)).join(', ')}` : ''}</span></div></div>`;
  const decisions = d.decisions.length
    ? `<section><h2>Decisions</h2><div class="scroll"><table><thead><tr><th>ID</th><th>Question</th><th>Owner</th><th>Answer</th></tr></thead><tbody>${d.decisions
        .map((x) => `<tr><td class="mono">${esc(x.id)}</td><td>${esc(x.question)}</td><td>${esc(x.owner)}</td><td>${x.answer ? esc(x.answer) : '<span class="pill fail">Unanswered</span>'}</td></tr>`)
        .join('')}</tbody></table></div></section>`
    : '';
  const impactHtml = imp
    ? `<section><h2>Impact</h2><div class="card impact"><div><div class="eyebrow">Before</div><p>${esc(imp.before)}</p></div><div><div class="eyebrow">After</div><p>${esc(imp.after)}</p></div><div><div class="eyebrow">Who depends on it</div><p>${esc(imp.depends_on)}</p></div><div><div class="eyebrow">What could break · watch after merge</div><p>${esc(imp.could_break)}</p><p class="muted">${esc(imp.watch_after_merge)}</p></div></div></section>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pre-PR Guard · ${esc(d.repo)}</title><style>${CSS}</style></head><body><div class="wrap">
<header><div class="eyebrow">Pre-PR Guard · local report</div><h1>${esc(d.cardId ? `${d.cardId}${d.cardTitle ? ` · ${d.cardTitle}` : ''}` : d.repo)}</h1>
<div class="meta"><span>repo <b>${esc(d.repo)}</b></span><span>branch <b>${esc(d.branch)}</b></span>${rec ? `<span>last run <b>${esc(rec.stage)}</b> at <b>${esc(when(rec.started_at))} UTC</b></span><span>files <b>${rec.files.length}</b></span><span>time <b>${secs(rec.ms)}</b> / ${secs(rec.budget_ms)}</span>` : ''}<span>generated <b>${esc(when(d.generated))} UTC</b></span></div></header>
<section class="hero"><div class="card verdict"><div class="eyebrow">Readiness</div><div class="big"><span class="dot ${vCls}"></span>${vLabel}</div><div class="why">${why}</div>${d.track ? `<div class="track"><b>Track record</b> · ${esc(d.track)}</div>` : ''}</div>${tiles}</section>
${rec ? `<section><h2>Findings</h2>${findingsTable(findings)}</section>${impactHtml}${decisions}<section><h2>Checks</h2>${checksTable(results)}</section>` : ''}
${d.trust ? trustSection(d.trust) : `<section><h2>Trust</h2><p class="muted">${esc(d.trustError ?? 'No history.')}</p></section>`}
<section><h2>Recent runs</h2>${runsTable(d.runs)}</section>
<footer>Generated by Pre-PR Guard on this machine. It flags and reports; humans decide. Nothing was approved, signed, merged or pushed. This file is not committed.</footer>
</div></body></html>
`;
}

/** Log this run, rewrite index.html, and keep a snapshot of the page as it was after this run. */
export function recordRun(root: string, cardId: string | null, entry: RunEntry): string {
  const dir = path.join(root, REPORT_DIR);
  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const snapName = `${entry.at.replace(/[:.]/g, '-')}-${entry.stage}${cardId ? `-${cardId}` : ''}.html`;
  entry.snapshot = `runs/${snapName}`;
  appendRun(root, entry);
  const html = renderDashboard(gather(root, cardId));
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  // Snapshot links are relative to reports/, so rewrite them for the runs/ folder.
  fs.writeFileSync(path.join(runsDir, snapName), html.replace(/href="runs\//g, 'href="'));
  const snaps = fs.readdirSync(runsDir).filter((f) => f.endsWith('.html')).sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPSHOTS))) fs.rmSync(path.join(runsDir, old));
  return path.relative(root, path.join(dir, 'index.html'));
}

/** Rewrite the dashboard without logging a run (used by `preguard trust`). */
export function refreshDashboard(root: string, cardId: string | null): string {
  const dir = path.join(root, REPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), renderDashboard(gather(root, cardId)));
  return path.relative(root, path.join(dir, 'index.html'));
}

