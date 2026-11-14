import { run } from './exec.ts';

export class Git {
  root: string;
  constructor(root: string) {
    this.root = root;
  }

  static findRoot(cwd: string): string | null {
    const r = run('git', ['rev-parse', '--show-toplevel'], { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  git(args: string[]): string {
    const r = run('git', args, { cwd: this.root });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.error}`);
    return r.stdout;
  }

  tryGit(args: string[]): string | null {
    const r = run('git', args, { cwd: this.root });
    return r.code === 0 ? r.stdout : null;
  }

  lines(args: string[]): string[] {
    return this.git(args).split('\n').map((l) => l.trim()).filter(Boolean);
  }

  head(): string | null {
    return this.tryGit(['rev-parse', 'HEAD'])?.trim() ?? null;
  }

  branch(): string {
    return this.tryGit(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? 'HEAD';
  }

  refExists(ref: string): boolean {
    return this.tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
  }

  /** Base branch: configured, else origin/HEAD, else main/master. */
  baseBranch(configured?: string | null): string | null {
    const candidates = [configured, this.tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim(), 'main', 'master', 'origin/main', 'origin/master'];
    for (const c of candidates) if (c && this.refExists(c)) return c;
    return null;
  }

  mergeBase(base: string): string | null {
    return this.tryGit(['merge-base', 'HEAD', base])?.trim() ?? null;
  }

  stagedFiles(): string[] {
    return this.lines(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  }

  /** Files changed vs a ref, including uncommitted and untracked changes. */
  changedSince(ref: string): string[] {
    const tracked = this.lines(['diff', '--name-only', '--diff-filter=ACMR', ref]);
    const untracked = this.lines(['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...tracked, ...untracked])].sort();
  }

  deletedSince(ref: string): string[] {
    return this.lines(['diff', '--name-only', '--diff-filter=D', ref]);
  }

  allFiles(): string[] {
    const tracked = this.lines(['ls-files']);
    const untracked = this.lines(['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...tracked, ...untracked])].sort();
  }

  /** Files with unstaged modifications (used to avoid clobbering partial stages). */
  unstagedFiles(): string[] {
    return this.lines(['diff', '--name-only']);
  }

  isDirty(): boolean {
    return this.git(['status', '--porcelain']).trim().length > 0;
  }

  showFile(ref: string, path: string): string | null {
    return this.tryGit(['show', `${ref}:${path}`]);
  }

  /** Added lines per file: { file -> [{line, text}] }. ref=null means staged vs HEAD. */
  addedLines(ref: string | null, files?: string[]): Map<string, { line: number; text: string }[]> {
    const args = ref === null ? ['diff', '--cached', '-U0', '--no-color'] : ['diff', '-U0', '--no-color', ref];
    if (files?.length) args.push('--', ...files);
    const out = this.tryGit(args) ?? '';
    const map = new Map<string, { line: number; text: string }[]>();
    let file: string | null = null;
    let lineNo = 0;
    for (const l of out.split('\n')) {
      if (l.startsWith('+++ ')) {
        file = l.startsWith('+++ b/') ? l.slice(6) : null;
        if (file && !map.has(file)) map.set(file, []);
      } else if (l.startsWith('@@')) {
        const m = /\+(\d+)(?:,(\d+))?/.exec(l);
        lineNo = m ? Number(m[1]) : 0;
      } else if (file && l.startsWith('+')) {
        map.get(file)!.push({ line: lineNo, text: l.slice(1) });
        lineNo++;
      }
    }
    return map;
  }

  /** Tree id of what's being checked: the index for a staged run, HEAD's tree if clean, else null. */
  currentTree(mode: 'staged' | 'branch' | 'all'): string | null {
    if (mode === 'staged') return this.tryGit(['write-tree'])?.trim() ?? null;
    if (this.isDirty()) return null;
    return this.tryGit(['rev-parse', 'HEAD^{tree}'])?.trim() ?? null;
  }

  headTree(): string | null {
    return this.tryGit(['rev-parse', 'HEAD^{tree}'])?.trim() ?? null;
  }

  userName(): string {
    return this.tryGit(['config', 'user.name'])?.trim() || 'unknown';
  }

  hooksDir(): string {
    const custom = this.tryGit(['config', '--get', 'core.hooksPath'])?.trim();
    if (custom) return custom;
    return this.git(['rev-parse', '--git-path', 'hooks']).trim();
  }
}
