import type { CheckResult, CheckStatus } from './types.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { red: c('31'), green: c('32'), yellow: c('33'), dim: c('2'), bold: c('1'), cyan: c('36') };

export const ICON: Record<CheckStatus, string> = {
  pass: color.green('✔'),
  fail: color.red('✘'),
  warn: color.yellow('▲'),
  not_run: color.dim('○'),
};

export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function printResults(results: CheckResult[], opts: { verbose?: boolean; maxDetails?: number } = {}): void {
  const width = Math.max(...results.map((r) => r.title.length), 10);
  for (const r of results) {
    const summary = r.status === 'not_run' ? color.dim(`not run: ${r.summary}`) : r.summary;
    console.log(`  ${ICON[r.status]} ${r.title.padEnd(width)}  ${summary}  ${color.dim(secs(r.ms))}`);
    const show = opts.verbose || r.status === 'fail' || r.status === 'warn';
    if (show) {
      const max = opts.maxDetails ?? 8;
      for (const d of r.details.slice(0, max)) console.log(`      ${color.dim('│')} ${d}`);
      if (r.details.length > max) console.log(`      ${color.dim(`│ … ${r.details.length - max} more`)}`);
      if (r.fix && r.status !== 'pass') console.log(`      ${color.cyan('→')} ${r.fix}`);
    }
  }
}

/**
 * Default developer view: only what needs action. Failures get up to 3 evidence lines and the fix;
 * warnings and "not run" get one line each (never hidden); passes collapse into one line.
 */
export function printCompact(results: CheckResult[]): void {
  const shown = results.filter((r) => r.status !== 'pass');
  const width = Math.max(...shown.map((r) => r.title.length), 0);
  for (const r of shown) {
    const text = r.status === 'not_run' ? color.dim(`not run: ${r.summary}`) : r.summary;
    console.log(`${ICON[r.status]} ${r.title.padEnd(width)}  ${text}`);
    if (r.status !== 'fail') continue;
    const ev = [...new Set(r.details.filter((d) => !/^ran /.test(d)))];
    for (const d of ev.slice(0, 3)) console.log(`  ${color.dim(d)}`);
    if (ev.length > 3) console.log(`  ${color.dim(`… ${ev.length - 3} more (-v)`)}`);
    if (r.fix) console.log(`  ${color.cyan('→')} ${r.fix}`);
  }
  const passed = results.filter((r) => r.status === 'pass');
  if (passed.length) console.log(`${ICON.pass} ${color.dim(`${passed.length} passed: ${passed.map((r) => r.title).join(', ')}`)}`);
}

/** Extract "file:line" evidence from tool output. */
export function parseFileLines(output: string, knownFiles: string[]): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  const known = new Set(knownFiles);
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const m = /([\w./@-]+\.[\w]+):(\d+)(?::\d+)?/.exec(line);
    if (m) {
      const file = m[1].replace(/^\.\//, '');
      if (known.size === 0 || known.has(file)) out.push({ file, line: Number(m[2]), text: line });
    }
  }
  return out;
}
