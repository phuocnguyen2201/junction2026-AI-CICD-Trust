# Pre-PR Guard

AI writes code faster than people can review it. PRs get too big to read carefully, reviewers approve because the tests are green, and teams fix what breaks after merge.


The AI drafts and flags. A human makes every decision. Pre-PR Guard never approves, signs, merges or pushes anything, and it doesn't change your existing PR review process.

For the full introduction, see [PRE-PR-GUARD.md](PRE-PR-GUARD.md).

## Installation

**Requirements:** Node.js 23.6 or newer and git.

```sh
cd preguard
npm install
npm link            # makes the `preguard` command available; undo with `npm unlink -g preguard`
```

To skip the global install, use an alias for the current terminal instead:

```sh
alias preguard="node /path/to/preguard/bin/preguard.mjs"
```

### Set up a repository

Run this in the repository you want to guard:

```sh
preguard init       # detects your tools, writes .preguard/rules.yml, asks before installing git hooks
```

Use `--hooks` to install the commit and pre-push hooks without asking, or `--no-hooks` to skip them.

### Enable the AI (optional)

The AI steps use only the provider set in `.preguard/rules.yml`:

```yaml
ai:
  provider: anthropic
  model: claude-sonnet-5-5
  send_code: true     # false: no code is ever sent, and the AI steps show as "not run"
```

Put the API key in your environment, not in the repo:

```sh
export ANTHROPIC_API_KEY=...
```

Without a key, every other check still runs. The AI steps are reported as "not run".

## Usage

| Command | When | What it does |
|---|---|---|
| `preguard check` | On commit (the hook runs it) | Fast checks on changed files. `--fix` auto-formats, `--all` checks every file |
| `preguard review` | Before push | Full checks + AI self-review on the branch. `--no-ai` runs the checks without AI |
| `preguard ready` | Before the PR | Writes the readiness report to `.preguard/reports/<id>.md` and prints the `Preguard-Status:` line for your commit message |
| `preguard trust` | Any time | Track record per kind of change from git history. `-v` lists the commit behind each number |
| `preguard report --open` | Any time | Opens the HTML dashboard: verdict, findings, checks, trust and recent runs |

A typical flow:

```sh
git commit -m "DEMO-104: return copies from list()"   # commit hook runs `preguard check`
preguard review                                       # everything the PR review would check, now
preguard ready                                        # 🟢 / 🟡 / 🔴, with the reasons
```

Common options: `--id <card-id>` picks the requirement card (the default comes from the branch name), `--json` prints machine-readable output, and `-v` shows details for passing checks too.

When you must proceed anyway, the bypass is recorded in the report:

```sh
preguard ready --bypass format --reason "Editor config fix lands separately"
```

Secrets, public API changes, migrations and unanswered decisions can't be bypassed.

`preguard start` and `preguard tests` (requirement card and tests from requirements) are not built yet in this prototype, so they are reported as "not run".

Run `preguard --help` for every command and option. To try it on synthetic code, see [demo/DEMO.md](demo/DEMO.md).
