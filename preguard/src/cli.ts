import { parseArgs } from 'node:util';
import { initCommand } from './commands/init.ts';
import { checkCommand } from './commands/check.ts';
import { reviewCommand } from './commands/review.ts';
import { readyCommand } from './commands/ready.ts';
import { trustCommand } from './commands/trust.ts';
import { reportCommand } from './commands/report.ts';
import { UsageError, type FilesMode } from './lib/context.ts';
import { RulesError } from './lib/rules.ts';
import { color } from './lib/output.ts';

const HELP = `preguard: catch PR-review issues on your machine, before the PR.

Usage:
  preguard init [--hooks | --no-hooks] [--force]   detect tools, write .preguard/rules.yml, offer git hooks
  preguard start <issue-file | ->                   requirement card + in-reach check        (M4)
  preguard tests <id>                               draft tests from acceptance criteria     (M4)
  preguard check [--staged | --all] [--fix]         fast commit-stage checks on changed files
  preguard review [--staged]                        full checks + AI self-review on the branch (--staged: what you're about to commit)
  preguard ready [--bypass <check> --reason "…"]    local readiness report 🟢/🟡/🔴 in .preguard/reports/
  preguard trust [-v]                               track record per category from git history (success, reverts, fixes)
  preguard report [--open]                          rebuild the HTML dashboard (.preguard/reports/index.html); also written after every run

Common options:
  --id <card-id>   requirement card to use (default: from branch name / branch diff)
  --json           machine-readable output
  -v, --verbose    show details for passing checks too
  --no-ai          skip the AI steps for this run (shown as "not run")

preguard never approves, signs, merges or pushes anything.`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      id: { type: 'string' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      staged: { type: 'boolean' },
      all: { type: 'boolean' },
      fix: { type: 'boolean' },
      hook: { type: 'boolean' },
      hooks: { type: 'boolean' },
      'no-hooks': { type: 'boolean' },
      force: { type: 'boolean' },
      bypass: { type: 'string' },
      reason: { type: 'string' },
      'no-run': { type: 'boolean' },
      open: { type: 'boolean' },
      'no-ai': { type: 'boolean' },
    },
  });
  const cwd = process.cwd();
  // --no-ai: deterministic checks only for this run (AI steps are reported as "not run", never hidden).
  if (values['no-ai']) process.env.PREGUARD_NO_AI = '1';
  switch (cmd) {
    case 'init':
      return initCommand({ cwd, force: values.force, hooks: values.hooks ? 'yes' : values['no-hooks'] ? 'no' : 'ask' });
    case 'check': {
      const mode: FilesMode | undefined = values.all ? 'all' : values.staged ? 'staged' : undefined;
      return checkCommand({ cwd, mode, id: values.id, fix: values.fix, json: values.json, hook: values.hook, verbose: values.verbose });
    }
    case 'review':
      return reviewCommand({ cwd, id: values.id, json: values.json, verbose: values.verbose, hook: values.hook, staged: values.staged });
    case 'ready':
      return readyCommand({ cwd, id: values.id, bypass: values.bypass, reason: values.reason, noRun: values['no-run'], json: values.json });
    case 'report':
      return reportCommand({ cwd, id: values.id, open: values.open });
    case 'trust':
      return trustCommand({ cwd, json: values.json, verbose: values.verbose });
    case 'start':
    case 'tests':
      console.log(color.yellow(`preguard ${cmd}: not built yet in this milestone. Stage reported as "not run".`));
      return 0;
    default:
      throw new UsageError(`unknown command "${cmd}" (try preguard --help)`);
  }
  void positionals;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UsageError || e instanceof RulesError) {
      console.error(color.red(`preguard: ${e.message}`));
      process.exit(2);
    }
    console.error(e);
    process.exit(3);
  },
);
