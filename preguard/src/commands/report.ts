import { spawn } from 'node:child_process';
import path from 'node:path';
import { Git } from '../lib/git.ts';
import { UsageError } from '../lib/context.ts';
import { loadRuns } from '../lib/state.ts';
import { refreshDashboard } from '../lib/dashboard.ts';

/** `preguard report [--open]`: rebuild the HTML dashboard (no checks run) and optionally open it. */
export function reportCommand(opts: { cwd: string; id?: string; open?: boolean }): number {
  const root = Git.findRoot(opts.cwd);
  if (!root) throw new UsageError('not inside a git repository');
  const rel = refreshDashboard(root, opts.id ?? loadRuns(root, 1)[0]?.card ?? null);
  console.log(`Dashboard: ${rel}`);
  if (opts.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [path.join(root, rel)], { detached: true, stdio: 'ignore' }).unref();
  }
  return 0;
}
