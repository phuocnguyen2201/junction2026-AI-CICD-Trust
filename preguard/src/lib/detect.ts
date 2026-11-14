import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.ts';
import type { Rules, TestMode } from './rules.ts';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'bin', 'obj', '.preguard']);

function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function walk(root: string, opts: { maxFiles?: number } = {}): string[] {
  const out: string[] = [];
  const max = opts.maxFiles ?? 20000;
  const stack = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(r);
      } else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

// ---------- package manager & scripts ----------

export interface PackageInfo {
  pm: 'npm' | 'pnpm' | 'yarn' | 'bun';
  scripts: Record<string, string>;
  deps: Set<string>;
  pkg: any | null;
}

export function readPackage(root: string): PackageInfo {
  const pkg = readJson(path.join(root, 'package.json'));
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  const deps = new Set<string>(Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }));
  return { pm, scripts: pkg?.scripts ?? {}, deps, pkg };
}

function scriptCmd(pm: PackageInfo['pm'], name: string, passArgs: boolean): string {
  const base = pm === 'npm' ? `npm run --silent ${name}` : pm === 'yarn' ? `yarn --silent ${name}` : `${pm} run --silent ${name}`;
  if (!passArgs) return base;
  return pm === 'npm' ? `${base} -- {files}` : `${base} {files}`;
}

function firstScript(p: PackageInfo, names: string[]): string | null {
  return names.find((n) => p.scripts[n]) ?? null;
}

// ---------- tools ----------

export function detectTools(root: string): { tools: Rules['tools']; test_modes: TestMode[]; notes: string[] } {
  const p = readPackage(root);
  const notes: string[] = [];
  const tools: Rules['tools'] = {
    format: { check: null, fix: null },
    lint: { command: null, fix: null },
    typecheck: { command: null },
    tests: { runner: null, related: null },
    e2e: null,
  };

  // Format
  const fmtCheck = firstScript(p, ['format:check', 'fmt:check', 'prettier:check', 'check:format']);
  const fmtFix = firstScript(p, ['format', 'format:fix', 'fmt', 'prettier:fix', 'prettier']);
  if (fmtCheck) tools.format.check = scriptCmd(p.pm, fmtCheck, true);
  if (fmtFix) tools.format.fix = scriptCmd(p.pm, fmtFix, true);
  if (!fmtCheck && p.deps.has('prettier')) {
    tools.format.check = 'npx --no-install prettier --check {files}';
    tools.format.fix ??= 'npx --no-install prettier --write {files}';
  } else if (!fmtCheck && p.deps.has('@biomejs/biome')) {
    tools.format.check = 'npx --no-install biome format {files}';
    tools.format.fix ??= 'npx --no-install biome format --write {files}';
  }

  // Lint
  const lint = firstScript(p, ['lint', 'eslint']);
  const lintFix = firstScript(p, ['lint:fix', 'eslint:fix']);
  if (lint) tools.lint.command = scriptCmd(p.pm, lint, true);
  else if (p.deps.has('eslint')) tools.lint.command = 'npx --no-install eslint {files}';
  if (lintFix) tools.lint.fix = scriptCmd(p.pm, lintFix, true);

  // Type check (whole project: type checkers need the full program)
  const tc = firstScript(p, ['typecheck', 'type-check', 'check:types', 'types', 'tsc']);
  if (tc) tools.typecheck.command = scriptCmd(p.pm, tc, false);
  else if (fs.existsSync(path.join(root, 'tsconfig.json')) && p.deps.has('typescript')) tools.typecheck.command = 'npx --no-install tsc --noEmit -p .';

  // Test runner
  const allScripts = Object.values(p.scripts).join('\n');
  if (p.deps.has('vitest') || /\bvitest\b/.test(allScripts)) {
    tools.tests.runner = 'vitest';
    tools.tests.related = 'npx --no-install vitest related --run --passWithNoTests {files}';
  } else if (p.deps.has('jest') || /\bjest\b/.test(allScripts)) {
    tools.tests.runner = 'jest';
    tools.tests.related = 'npx --no-install jest --findRelatedTests --passWithNoTests {files}';
  } else if (/node\s+(?:[^\n]*\s)?--test\b/.test(allScripts)) {
    tools.tests.runner = 'node-test';
    tools.tests.related = 'node --test {tests}';
  } else if (p.deps.has('mocha')) {
    tools.tests.runner = 'mocha';
    tools.tests.related = 'npx --no-install mocha {tests}';
  }

  const e2e = firstScript(p, ['test:e2e', 'e2e']);
  if (e2e) tools.e2e = scriptCmd(p.pm, e2e, false);
  else if (p.deps.has('@playwright/test')) tools.e2e = 'npx --no-install playwright test';
  else if (p.deps.has('cypress')) tools.e2e = 'npx --no-install cypress run';

  // Test modes: every "test:<mode>" script, else "test"
  const skip = /^(watch|coverage|cov|ui|debug|update|related|list|ci|e2e)$/;
  const modes: TestMode[] = Object.keys(p.scripts)
    .filter((n) => /^test:[\w.-]+$/.test(n) && !skip.test(n.slice(5)))
    .map((n) => ({ name: n.slice(5), command: scriptCmd(p.pm, n, false) }));
  if (!modes.length && p.scripts.test) modes.push({ name: 'default', command: scriptCmd(p.pm, 'test', false) });

  if (!p.pkg) notes.push('no package.json found: JS tools not detected; edit tools: in rules.yml for your stack');
  for (const [k, v] of Object.entries({ format: tools.format.check, lint: tools.lint.command, typecheck: tools.typecheck.command, tests: tools.tests.runner, e2e: tools.e2e })) {
    if (!v) notes.push(`no ${k} tool detected: that check will report "not run"`);
  }
  return { tools, test_modes: modes, notes };
}

// ---------- pinned environment ----------

export interface Pin {
  runtime: 'node' | 'dotnet' | 'python';
  spec: string;
  source: string;
  /** Extra semantics, e.g. .NET rollForward. */
  note?: string;
}

export function detectPins(root: string): Pin[] {
  const pins: Pin[] = [];
  const t = (f: string) => readText(path.join(root, f))?.trim() || null;
  const nvm = t('.nvmrc');
  const nodeVersion = t('.node-version');
  const toolVersions = t('.tool-versions');
  const pkg = readJson(path.join(root, 'package.json'));
  if (nvm) pins.push({ runtime: 'node', spec: nvm.split('\n')[0].trim(), source: '.nvmrc' });
  else if (nodeVersion) pins.push({ runtime: 'node', spec: nodeVersion.split('\n')[0].trim(), source: '.node-version' });
  else if (toolVersions && /^nodejs\s+(\S+)/m.test(toolVersions)) pins.push({ runtime: 'node', spec: /^nodejs\s+(\S+)/m.exec(toolVersions)![1], source: '.tool-versions' });
  else if (pkg?.volta?.node) pins.push({ runtime: 'node', spec: String(pkg.volta.node), source: 'package.json volta.node' });
  else if (pkg?.engines?.node) pins.push({ runtime: 'node', spec: String(pkg.engines.node), source: 'package.json engines.node' });

  const gj = readJson(path.join(root, 'global.json'));
  if (gj?.sdk?.version) {
    const rf = gj.sdk.rollForward ?? 'latestPatch';
    pins.push({ runtime: 'dotnet', spec: String(gj.sdk.version), source: 'global.json sdk.version', note: `rollForward=${rf}` });
  }
  const py = t('.python-version');
  if (py) pins.push({ runtime: 'python', spec: py.split('\n')[0].trim(), source: '.python-version' });
  else if (toolVersions && /^python\s+(\S+)/m.test(toolVersions)) pins.push({ runtime: 'python', spec: /^python\s+(\S+)/m.exec(toolVersions)![1], source: '.tool-versions' });
  return pins;
}

/** The runtime version the repo's commands would actually use (PATH resolution in the repo dir). */
export function usedRuntime(root: string, runtime: Pin['runtime']): string | null {
  const cmd = runtime === 'node' ? ['node', ['--version']] : runtime === 'dotnet' ? ['dotnet', ['--version']] : ['python3', ['--version']];
  const r = run(cmd[0] as string, cmd[1] as string[], { cwd: root, timeoutMs: 10000 });
  if (r.code !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr);
  return m ? m[1] : null;
}

// ---------- CI, layers, public API ----------

export function detectCi(root: string): string[] {
  const found: string[] = [];
  const wf = path.join(root, '.github/workflows');
  if (fs.existsSync(wf)) for (const f of fs.readdirSync(wf)) if (/\.ya?ml$/.test(f)) found.push(`.github/workflows/${f}`);
  for (const f of ['.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml']) {
    if (fs.existsSync(path.join(root, f))) found.push(f);
  }
  return found;
}

/** Node versions CI uses (e.g. actions/setup-node node-version). Read-only. */
export function ciNodeVersions(root: string): { file: string; line: number; version: string }[] {
  const out: { file: string; line: number; version: string }[] = [];
  for (const f of detectCi(root)) {
    const text = readText(path.join(root, f)) ?? '';
    text.split('\n').forEach((l, i) => {
      const m = /node-version:\s*['"]?([\w.*x-]+)['"]?/.exec(l);
      if (m && !/\$\{\{/.test(l)) out.push({ file: f, line: i + 1, version: m[1] });
    });
  }
  return out;
}

const BACKEND_DIRS = ['api', 'server', 'backend', 'services', 'src/server', 'src/api', 'functions'];
const FRONTEND_DIRS = ['web', 'client', 'frontend', 'ui', 'public', 'src/client', 'src/components', 'src/pages', 'pages', 'components'];

export function detectLayers(root: string): Rules['layers'] {
  const isDir = (d: string) => fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory();
  return {
    backend: BACKEND_DIRS.filter(isDir).map((d) => `${d}/**`),
    frontend: FRONTEND_DIRS.filter(isDir).map((d) => `${d}/**`),
  };
}

export function detectPublicApi(root: string, files = walk(root)): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const base = path.basename(f);
    if (/^(openapi|swagger)\.(json|ya?ml)$/.test(base) || base === 'contract.json' || /\.proto$/.test(base) || base === 'schema.graphql') out.add(f);
  }
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && !pkg.private && (pkg.exports || pkg.main)) {
    out.add('package.json');
    if (typeof pkg.main === 'string') out.add(pkg.main.replace(/^\.\//, ''));
  }
  return [...out].sort();
}
