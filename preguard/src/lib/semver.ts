// Tiny version matcher for runtime pins. Supports: exact/partial ("22", "22.11", "v22.11.0"),
// x-ranges ("22.x"), ^, ~, comparators (>=, >, <=, <, =), space-joined AND, "||" OR.
// Returns null when the spec can't be evaluated (e.g. "lts/*", "node", "latest").

export type Ver = [number, number, number];

export function parseVersion(v: string): Ver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function partial(spec: string): { parts: number[] } | null {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(spec);
  if (!m) return null;
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || p === 'x' || p === '*') break;
    parts.push(Number(p));
  }
  return { parts };
}

function matchOne(v: Ver, c: string): boolean | null {
  if (c === '*' || c === 'x' || c === '') return true;
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(c);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = partial(m[2]);
  if (!p) return null;
  const base: Ver = [p.parts[0] ?? 0, p.parts[1] ?? 0, p.parts[2] ?? 0];
  switch (op) {
    case '':
    case '=':
      return p.parts.every((n, i) => v[i] === n);
    case '>=':
      return cmp(v, base) >= 0;
    case '>':
      return cmp(v, base) > 0;
    case '<=':
      return cmp(v, base) <= 0;
    case '<':
      return cmp(v, base) < 0;
    case '^':
      if (cmp(v, base) < 0) return false;
      if (base[0] > 0 || p.parts.length < 2) return v[0] === base[0];
      if (base[1] > 0 || p.parts.length < 3) return v[0] === 0 && v[1] === base[1];
      return v[0] === 0 && v[1] === 0 && v[2] === base[2];
    case '~':
      if (cmp(v, base) < 0) return false;
      return p.parts.length < 2 ? v[0] === base[0] : v[0] === base[0] && v[1] === base[1];
  }
  return null;
}

export function satisfies(version: string, spec: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  let anyTrue = false;
  for (const alt of spec.split('||')) {
    const comps = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    let all = true;
    for (const c of comps.length ? comps : ['*']) {
      const r = matchOne(v, c);
      if (r === null) return null;
      if (!r) all = false;
    }
    if (all) anyTrue = true;
  }
  return anyTrue;
}
