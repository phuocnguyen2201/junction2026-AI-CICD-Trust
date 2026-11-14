# Demo: "I'm done", then shift left

**Story:** a developer has finished *"Organisers can remove an attendee"* (card `DEMO-201`). Their tests pass and it looks ready. Without Pre-PR Guard, its four problems would only show up at PR review or after merge. With it, one command finds them on the developer's machine in about 10 seconds.

Everything is local. Nothing is pushed, and preguard never approves or merges anything.

## Setup (once, before the audience arrives)

```sh
# Make the `preguard` command available (once per machine; undo with `npm unlink -g preguard`):
(cd ~/junction2026/preguard && npm link)
# …or, without installing anything, for this terminal only:
#   alias preguard="node ~/junction2026/preguard/bin/preguard.mjs"
cd ~/junction2026
node demo/build.mjs                       # (re)builds demo/repo with all branches
rm -rf demo/work && git clone -q demo/repo demo/work && cd demo/work
git config user.name "Demo Dev" && git config user.email demo-dev@example.invalid
git switch -q demo/feature-done
preguard init --hooks                     # keeps the committed rule pack, installs the hooks
```

## 1. "Looks done" (30 s)

```sh
git log --oneline -3
npm run --silent test:default             # 14 passed, 0 failed
```

> "The tests pass. Normally this goes straight to a PR."

## 2. Shift left: everything merge would find, now (60 s)

```sh
preguard review
```

The result is **BLOCKED**, with evidence for each issue:

| Finding | Normally found… | What it means |
|---|---|---|
| **test inventory**: `test/remove.test.js` doesn't run in the `legacy` mode | after merge, maybe never | the legacy client's behaviour is untested |
| **public API flag**: `+ DELETE /attendees/:id`, decision D-1 unanswered | in PR review, after the code is written | a long-term promise the API owners must make |
| **format + scope**: `web/app.js` re-indented, outside the card | in PR review, as noise | unrelated diff the reviewer has to read |
| **AI review** (Claude Sonnet): the comment says `decodeURIComponent` never throws | maybe never | false, it throws `URIError` on `%E0%A4%A`; comes with the MDN link |
| **AI review**: legacy ids are numbers but URL ids are strings | after merge | the AI spots the hidden bug even before the test runs in legacy mode |

## 3. The moment that sells it (45 s)

Put the test into the legacy mode, as the inventory check asked:

```sh
sed -i '' 's#test/web-format.test.js"#test/web-format.test.js test/remove.test.js"#' package.json
preguard review
```

The result: **`all tests (every mode)`: failing in legacy.** `AC1: DELETE /attendees/:id …` fails.

> "The missing test mode was hiding a real bug. Legacy ids are numbers, but the id from the URL is a string, so `1 === '1'` is false. This is exactly the kind of bug that escapes to production."

## 4. Fix it (45 s)

```sh
# the bug
sed -i '' 's/(a) => a.id === id)/(a) => String(a.id) === String(id))/' api/store.js
# the noise (the commit hook would also do this automatically)
preguard check --fix
```

The **human decision**: the API owners answer D-1. Open `requirements/DEMO-201.json` and set:

```json
"answer": "Approved by API owners: hard delete, numeric and string ids both accepted."
```

> "The tool can flag the decision, but it can never make it."

## 5. Commit and get the readiness report (30 s)

```sh
git add -A && git commit -m "DEMO-201: run remove tests in legacy mode, fix id compare, drop noise"
preguard ready
```

The commit hook runs and passes. The report is at `.preguard/reports/DEMO-201.md`. It's 🔴 until you also fix the false `decodeURIComponent` comment the AI found (wrap the call in `try/catch` and return 400 on a `URIError`), then 🟢. `ready` prints the `Preguard-Status:` line to put in the final commit message.

Open the report and show:
- requirement match (AC1 to AC3 mapped to tests)
- checks run
- findings marked fixed
- the decision with its answer
- "not verified"

> "Four issues that would have cost a review round, or an incident, were found and fixed before the code ever left the laptop."

## 6. Why should anyone trust this? (45 s)

```sh
preguard trust
```

This is all from the repo's git history (synthetic for the demo):
- **Before vs with Pre-PR Guard:** failure rate 31% → 5% (reverted or needing a follow-up fix within 14 days)
- **Trust per category:** `backend · human` has *earned* trust (18/18, 95% lower bound 82%). The others show how many more successes in a row they need
- **Per developer (5 fictional devs):** PRs, worked perfectly, hit a defect, reverted, and the trust ratio. Dev Amber has earned trust (20/20); Dev Cedar and Dev Dune are below the bar. Use it to choose review depth, not to rank people
- **Pre-PR Guard's own accuracy:** 1 false green out of 40 🟢 reports (`EVT-338`), and the one bypass that was merged anyway failed (`EVT-346`)

`preguard trust -v` lists every task with the commit that proves its outcome.

**Show it visually:** `preguard report --open` opens `.preguard/reports/index.html`. That page has the verdict, findings with evidence, the impact, every check, the trust statistics and the recent runs. It's rewritten after every `check`, `review`, `ready` and `trust` run, and each run also keeps a snapshot in `.preguard/reports/runs/`.

> "Trust isn't a feeling here. It's a number per kind of change, with the commits behind it, and it can be lost again."

## Optional: bypass

When a developer has to proceed anyway, for example because a formatter fix lands separately:

```sh
preguard ready --bypass format --reason "Editor config fix lands in a separate change next week"
```

- It's allowed. The report stays 🔴 and carries "bypassed by <name>: <reason>", so the bypass is never silent.
- The bypass only covers that exact commit; the next commit needs a new one.
- Secrets, public API changes, migrations and unanswered decisions can never be bypassed. `--bypass public_api` is refused.

## Reset

```sh
cd ~/junction2026 && rm -rf demo/work    # then repeat Setup
```
