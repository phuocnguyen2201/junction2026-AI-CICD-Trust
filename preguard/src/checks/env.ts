import { ciNodeVersions, detectPins, usedRuntime, type Pin } from '../lib/detect.ts';
import { parseVersion, satisfies } from '../lib/semver.ts';
import type { Check } from '../lib/context.ts';
import type { Finding } from '../lib/types.ts';

const FIX: Record<Pin['runtime'], (spec: string) => string> = {
  node: (s) => `switch runtime to the pin, e.g. \`nvm install ${s} && nvm use ${s}\` (or fnm/volta), then re-run`,
  dotnet: (s) => `install .NET SDK ${s} (global.json) and make sure \`dotnet --version\` reports it`,
  python: (s) => `switch to Python ${s}, e.g. \`pyenv install ${s} && pyenv local ${s}\``,
};

export const pinnedEnvCheck: Check = (ctx) => {
  const r = ctx.rules.pinned_env;
  const pins: Pin[] =
    r.source === 'manual'
      ? (['node', 'dotnet', 'python'] as const).filter((k) => r[k]).map((k) => ({ runtime: k, spec: String(r[k]), source: '.preguard/rules.yml pinned_env' }))
      : detectPins(ctx.root);
  if (!pins.length) {
    return { id: 'pinned_env', title: 'pinned env', status: 'not_run', summary: 'no runtime pin found (.nvmrc, .node-version, global.json, .python-version, engines)', details: [], findings: [] };
  }
  const details: string[] = [];
  const findings: Finding[] = [];
  const env: { runtime: string; pinned: string; source: string; used: string | null; match: boolean | null }[] = [];
  let status: 'pass' | 'fail' | 'warn' = 'pass';
  let fix: string | undefined;

  for (const pin of pins) {
    const used = usedRuntime(ctx.root, pin.runtime);
    const match = used ? satisfies(used, pin.spec) : false;
    env.push({ runtime: pin.runtime, pinned: pin.spec, source: pin.source, used, match });
    if (!used) {
      status = 'fail';
      details.push(`${pin.runtime}: pinned "${pin.spec}" (${pin.source}) but no ${pin.runtime} runtime found on PATH`);
      fix = FIX[pin.runtime](pin.spec);
    } else if (match === null) {
      if (status === 'pass') status = 'warn';
      details.push(`${pin.runtime}: can't evaluate pin "${pin.spec}" (${pin.source}); used ${used}`);
    } else if (!match) {
      status = 'fail';
      const newer = (parseVersion(used)?.[0] ?? 0) > (parseVersion(pin.spec.replace(/^[^\d]*/, ''))?.[0] ?? 0);
      details.push(`${pin.runtime}: pinned "${pin.spec}" (${pin.source}) but commands run on ${used}${newer ? ' (newer than pinned)' : ''}`);
      findings.push({
        id: `ENV-${pin.runtime}`,
        category: 'env_mismatch',
        severity: 'high',
        confidence: 1,
        file: pin.source.split(' ')[0],
        line: 1,
        reason: `Tests would run on ${pin.runtime} ${used}, not the pinned ${pin.spec}; results may not predict CI or production`,
        evidence: `pin "${pin.spec}" from ${pin.source}; \`${pin.runtime} --version\` in repo = ${used}`,
        origin: 'check',
      });
      fix = FIX[pin.runtime](pin.spec);
    } else {
      details.push(`${pin.runtime} ${used} matches "${pin.spec}" (${pin.source})`);
    }
    if (pin.runtime === 'dotnet' && /rollForward=(latestMajor|latestFeature|latestMinor|major|minor|feature)/.test(pin.note ?? '')) {
      if (status === 'pass') status = 'warn';
      details.push(`dotnet: global.json ${pin.note} lets a newer SDK than pinned run the tests`);
    }
  }

  // CI and local must agree, or "local passes" stops predicting "CI passes".
  const nodePin = pins.find((p) => p.runtime === 'node');
  if (nodePin) {
    for (const ci of ciNodeVersions(ctx.root)) {
      const ok = satisfies(ci.version.replace(/\.x$/, ''), nodePin.spec);
      if (ok === false) {
        status = 'fail';
        details.push(`CI ${ci.file}:${ci.line} uses node-version ${ci.version}, repo pins "${nodePin.spec}"`);
        findings.push({ id: 'ENV-ci', category: 'env_mismatch', severity: 'high', confidence: 1, file: ci.file, line: ci.line, reason: 'CI and the repo pin disagree on the Node version', evidence: `node-version: ${ci.version} vs ${nodePin.source} "${nodePin.spec}"`, origin: 'check' });
      }
    }
  }

  const summary =
    status === 'pass'
      ? env.map((e) => `${e.runtime} ${e.used} = pin "${e.pinned}"`).join(', ')
      : status === 'warn'
        ? 'pin could not be fully verified'
        : env.filter((e) => !e.match).map((e) => `${e.runtime}: pinned ${e.pinned}, used ${e.used ?? 'none'}`).join('; ') || 'CI/pin mismatch';
  return { id: 'pinned_env', title: 'pinned env', status, summary, details, findings, fix, data: { env } };
};
