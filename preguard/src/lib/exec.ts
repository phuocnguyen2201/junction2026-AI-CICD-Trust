import { spawnSync } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  error?: string;
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run a program directly (no shell). */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = { cwd: process.cwd() },
): ExecResult {
  const start = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ms: Date.now() - start,
    timedOut,
    error: r.error && !timedOut ? r.error.message : undefined,
  };
}

/**
 * Run a configured shell command from the rule pack.
 * Placeholders: {files} and {tests} are replaced with shell-quoted path lists.
 */
export function runCommand(
  template: string,
  opts: { cwd: string; timeoutMs?: number; files?: string[]; tests?: string[]; env?: NodeJS.ProcessEnv },
): ExecResult & { command: string } {
  const command = expandCommand(template, opts.files, opts.tests);
  const r = run('/bin/sh', ['-c', command], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    env: { ...process.env, ...opts.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return { ...r, command };
}

export function expandCommand(template: string, files?: string[], tests?: string[]): string {
  return template
    .replace(/\{files\}/g, (files ?? []).map(shellQuote).join(' '))
    .replace(/\{tests\}/g, (tests ?? []).map(shellQuote).join(' '));
}
