import fs from 'node:fs';
import path from 'node:path';

// Static import graph for JS/TS, used to find tests related to changed files
// when the runner (e.g. node:test) can't do it itself.

const CODE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/;
export const TEST_FILE = /(^|\/)(test|tests|__tests__)\/.*\.(m?js|cjs|jsx|ts|tsx|mts)$|\.(test|spec)\.(m?js|cjs|jsx|ts|tsx|mts)$/;

export function isCode(f: string): boolean {
  return CODE.test(f);
}

export function isTestFile(f: string): boolean {
  return TEST_FILE.test(f) && !/(^|\/)(fixtures?|helpers?)\//.test(f);
}

const SPEC_RE = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;

function resolveSpec(root: string, fromFile: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const tries = [base, ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts'].map((e) => base + e), ...['index.js', 'index.ts', 'index.mjs'].map((i) => `${base}/${i}`)];
  // TS-style ".js" import that points at a ".ts" file
  if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  for (const t of tries) if (known.has(t)) return t;
  return null;
}

/** Map: file -> files it imports (repo-relative). */
export function buildImportGraph(root: string, files: string[]): Map<string, string[]> {
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const f of files) {
    if (!isCode(f)) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    const deps: string[] = [];
    for (const m of src.matchAll(SPEC_RE)) {
      const r = resolveSpec(root, f, m[1], known);
      if (r) deps.push(r);
    }
    graph.set(f, deps);
  }
  return graph;
}

/** Test files that (transitively) import any of the changed files, plus changed test files. */
export function relatedTests(graph: Map<string, string[]>, changed: string[]): string[] {
  const changedSet = new Set(changed);
  const memo = new Map<string, boolean>();
  const reaches = (f: string, seen: Set<string>): boolean => {
    if (changedSet.has(f)) return true;
    if (memo.has(f)) return memo.get(f)!;
    if (seen.has(f)) return false;
    seen.add(f);
    const r = (graph.get(f) ?? []).some((d) => reaches(d, seen));
    memo.set(f, r);
    return r;
  };
  return [...graph.keys()].filter((f) => isTestFile(f) && reaches(f, new Set())).sort();
}
