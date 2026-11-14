import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Git } from '../lib/git.ts';
import { defaultRules, loadRules, renderRules, RULES_PATH } from '../lib/rules.ts';
import { detectCi, detectLayers, detectPins, detectPublicApi, detectTools, usedRuntime } from '../lib/detect.ts';
import { ensureStateIgnored } from '../lib/state.ts';
import { color } from '../lib/output.ts';
import { UsageError } from '../lib/context.ts';

const MARK = '# preguard-managed hook';
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/preguard.mjs');

function hookScript(command: string): string {
  return `#!/bin/sh
${MARK} (remove this file to uninstall; bypass once with --no-verify, which the readiness report will show as "not run")
exec "${process.execPath}" "${CLI}" ${command} "$@"
`;
}

export async function initCommand(opts: { cwd: string; force?: boolean; hooks?: 'yes' | 'no' | 'ask' }): Promise<number> {
  const root = Git.findRoot(opts.cwd);
  if (!root) throw new UsageError('not inside a git repository');
  const git = new Git(root);
  const rulesFile = path.join(root, RULES_PATH);

  console.log(color.bold('preguard init') + color.dim(`  ${root}`));
  const { tools, test_modes, notes } = detectTools(root);
  const pins = detectPins(root);
  const ci = detectCi(root);

  console.log('\nDetected (nothing is installed or changed in your tools):');
  const row = (k: string, v: string | null) => console.log(`  ${k.padEnd(12)} ${v ?? color.dim('none')}`);
  row('format', tools.format.check);
  row('lint', tools.lint.command);
  row('type check', tools.typecheck.command);
  row('test runner', tools.tests.runner);
  row('test modes', test_modes.map((m) => m.name).join(', ') || null);
  for (const p of pins) row(`pin ${p.runtime}`, `"${p.spec}" from ${p.source}${p.note ? ` (${p.note})` : ''}; in use: ${usedRuntime(root, p.runtime) ?? 'not found'}`);
  if (!pins.length) row('pinned env', null);
  row('CI config', ci.length ? `${ci.join(', ')} (read-only)` : null);
  for (const n of notes) console.log(color.yellow(`  ! ${n}`));

  if (fs.existsSync(rulesFile) && !opts.force) {
    loadRules(root); // validate the existing pack
    console.log(`\n${RULES_PATH} already exists: kept as is (use --force to regenerate).`);
  } else {
    const rules = defaultRules();
    rules.base_branch = git.baseBranch(null)?.replace(/^origin\//, '') ?? 'main';
    rules.tools = tools;
    rules.test_modes = test_modes;
    rules.layers = detectLayers(root);
    rules.public_api = detectPublicApi(root);
    const text = renderRules(rules, { pinned: pins.map((p) => `${p.runtime} "${p.spec}" (${p.source})`), ci });
    fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
    fs.writeFileSync(rulesFile, text);
    loadRules(root); // round-trip validation
    console.log(`\nWrote ${RULES_PATH}. Review it, then commit it so CI and every developer share it.`);
    if (!rules.ai.provider) console.log(color.dim('  ai.provider is empty: AI steps will be reported as "not run" until an approved provider is set.'));
  }
  ensureStateIgnored(root);
  await offerHooks(git, opts.hooks ?? 'ask');
  return 0;
}

async function offerHooks(git: Git, mode: 'yes' | 'no' | 'ask'): Promise<void> {
  const dir = path.resolve(git.root, git.hooksDir());
  const plan = [
    { name: 'pre-commit', command: 'check --fix --hook' },
    { name: 'pre-push', command: 'review --hook' },
  ];
  const managers = ['.husky', '.lefthook.yml', 'lefthook.yml', '.pre-commit-config.yaml'].filter((f) => fs.existsSync(path.join(git.root, f)));

  console.log('\nGit hooks (optional):');
  for (const h of plan) console.log(`  ${h.name.padEnd(10)} → preguard ${h.command}`);
  if (managers.length) {
    console.log(color.yellow(`  This repo uses a hook manager (${managers.join(', ')}). Not touching it. Add these lines to it yourself:`));
    for (const h of plan) console.log(`    ${h.name}: "${process.execPath}" "${CLI}" ${h.command}`);
    return;
  }
  if (mode === 'no') {
    console.log(color.dim('  Skipped (--no-hooks). Run `preguard init --hooks` later to install.'));
    return;
  }
  if (mode === 'ask') {
    if (!process.stdin.isTTY) {
      console.log(color.dim('  Not installed: no terminal to ask for consent. Re-run with --hooks to install.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`  Install into ${path.relative(git.root, dir) || dir}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log(color.dim('  Not installed.'));
      return;
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const h of plan) {
    const p = path.join(dir, h.name);
    if (fs.existsSync(p) && !fs.readFileSync(p, 'utf8').includes(MARK)) {
      console.log(color.yellow(`  ${h.name}: an existing hook is there; left untouched. Add: "${process.execPath}" "${CLI}" ${h.command}`));
      continue;
    }
    fs.writeFileSync(p, hookScript(h.command), { mode: 0o755 });
    console.log(color.green(`  installed ${h.name}`));
  }
}
