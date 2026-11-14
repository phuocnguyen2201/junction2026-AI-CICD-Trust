# Pre-PR Guard

**Catch problems while the feature is still being built, before anyone reviews the PR.**

---

## The problem

Today, most of the checking happens at PR review. By then the code is written, the design is fixed, and every issue costs another review round.

### What actually happens

AI writes code faster than people can review it. PRs get bigger than anyone can read carefully.

So reviewers skim. The tests are green, so they approve. The code is merged, and when something breaks, the team fixes it afterwards.

"Approve, then fix what breaks" has become the normal process.

### The same issues keep coming back

- a public API change that nobody approved
- a test runs in one mode but not in another
- a code comment states something false, and the design follows from it
- unrelated formatting that reviewers still have to read

Each one is found late, by a reviewer who is already overloaded, or by users after merge.

### Our answer

**Don't wait for something to break. Check early, while the change is still small and still on the developer's machine.**

Problems are flagged as soon as they are committed, and decisions go to their owners before the code is written. Reviewers no longer have to find every issue in a PR too big to read.

## The shift

| | Today | With Pre-PR Guard |
|---|---|---|
| When issues are found | At PR review, or after merge | While developing, on the developer's machine |
| Who finds them | The reviewer | The developer, with a local check and AI self-review |
| Design decisions | Raised in review, after the code exists | Raised at the start, on the requirement card |
| PR review | Heavy: finds the bugs | Light: confirms the decisions |

The existing PR review process stays as it is. Pre-PR Guard runs before it.

## How it works

1. **Start:** the issue becomes a requirement card with acceptance criteria, scope, and any open decisions plus who owns them.
2. **Tests first:** tests are written from the criteria before the code.
3. **On commit (< 30 s):** format, lint, types, pinned runtime, secrets, related tests, public API flag.
4. **Before push (< 5 min):** every test in every mode, scope against the card, API contract, and an AI self-review.
5. **Ready:** one report: 🟢 Ready, 🟡 Ready with notes, or 🔴 Not ready. The verdict goes into the final commit message as `Preguard-Status: green | yellow | red`.

## The role of AI

| The AI does | The AI never does |
|---|---|
| **Drafts:** the requirement card, tests from the criteria, the impact report | Approve, sign, merge or push |
| **Flags:** false claims, fixes wider than the issue, missing test modes, scope drift | Answer a decision that belongs to an owner |
| **Raises decisions** it must not make, and names who owns them | Learn or change itself: no fine-tuning, no memory between runs |

The developer decides what to fix, and a human makes every decision. With the AI turned off, the other checks still run and the AI steps show as "not run".

## Why trust the AI

We don't ask anyone to trust the AI. It has to follow rules, and its record is measured.

1. **Evidence or it's dropped.** A finding must quote a `file:line` that exists in the change, and the tool checks this without AI. A claim about an external library needs a source link.
2. **Strict output.** The AI returns JSON in a fixed format. If the output is invalid, the step is marked "not run". The tool never guesses.
3. **The AI doesn't hold the gate.** Tests, types, the runtime pin, the API flag, secrets and scope are checked without AI. The AI adds findings on top of them.
4. **Nothing hidden.** If a step didn't run, the report says so, and the verdict can't be 🟢.
5. **Trust is earned for each kind of change, and can be lost.** For example, backend changes can earn trust while frontend changes are still building it, and one escaped defect lowers trust again.

## What we measure

All of this comes from data every project already has: **git history** and **PR reviews**.

| Metric | Question it answers | Computed from |
|---|---|---|
| **Change failure rate** | Is shipping safer? | PRs reverted, or followed by a fix to the same files within 14 days, before vs. after adoption |
| **False green rate** | When the report says 🟢, is it right? | 🟢 commits that were later reverted or fixed |
| **AI finding precision** | Are the AI's findings real? | Findings fixed or `/accept`ed vs. `/refute`d |
| **Review rounds per PR** | Is PR review lighter? | "Changes requested" reviews on each PR |
| **Where issues are caught** | Is checking moving earlier? | Each finding's stage: local, PR review, or after merge |

`preguard trust` computes these, and `preguard trust -v` lists the commit behind every number.

**How the baseline works:** the "before" rate can be measured today from a project's existing git history, as long as commit subjects carry issue ids. The "after" rate needs a few weeks of pilot.

**Limits:** a fix whose commit message doesn't say fix, hotfix or bug isn't counted, and neither is a bug fixed in different files.

> The numbers in the demo (for example 31% → 5%) are synthetic history, written by hand to show the output. They are not a result.

## In one line

**The AI drafts and flags with evidence, a human makes every decision, and the project's own history shows whether to trust it.**
