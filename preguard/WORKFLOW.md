# Pre-PR Guard

**Catch PR-review issues on the developer's machine, before the PR, and prove with data when the work can be trusted.**

> Pre-product prototype. All demo code, developers and history are synthetic.

---

## The problem

Teams already review AI-written pull requests with AI help. Those reviews keep finding the same kinds of problems:

- **Silent failures:** input quietly dropped instead of rejected
- **Fixes wider than the issue:** a fix that hides more than the reported case
- **Tests that share the code's assumptions,** or never run in every mode
- **False claims in comments** about libraries and runtimes
- **Environment mismatch:** tests pass on a newer runtime than the one pinned
- **Drift from the request,** from stray formatting up to a different design
- **Design decisions raised too late,** after 1,000+ lines are written

Every one of these is found **after** the code is written and the PR is open. That's the most expensive point to find them: a review round, reviewer time, CI reruns, or an incident after merge.

## The idea

Move those checks **left, onto the developer's machine**, and keep humans accountable for the decisions only humans should make.

The existing PR review process stays exactly as it is. Pre-PR Guard runs before it, so fewer issues reach it. It flags and reports; it never approves, signs, merges or pushes anything.

---

## How it works: one task, from a developer's point of view

```
 0. Requirement card ─► 1. Tests first ─► 2. Code ─► 3. Commit ─► 4. Review ─► 5. Ready ─► PR
    what "done" means     from the card             fast checks   everything    one verdict
    + who decides what                              (< 30 s)      incl. AI      🟢 🟡 🔴
```

### 0 · Requirement card: agree on "done" before writing code

Each task starts as a small card: acceptance criteria, what's in and out of scope, a risk tier, the expected blast radius, and **open decisions with a named owner**.

Some decisions are never the developer's or the AI's to make:
- a public API shape (a long-term promise)
- a default data format (affects all users)
- whether a rule should break builds (policy)
- a design that differs from what was asked (owner intent)

The card names who decides each one, before the code exists. In one of the four real PRs our concept is based on, all four human decisions came up *after* more than 1,000 lines were written.

### 1 · Tests from the requirement, before the code

Tests are written from the acceptance criteria, without looking at the implementation, so they can't share its assumptions. Every task also gets a **regression test** for the behaviour next to the change, and every new test must run in **every test mode** the project has.

### 2 · Commit: fast checks, in seconds

When the developer commits, only the changed files are checked:

- **Runtime vs pin:** the runtime the tests use must match the project's pin and CI's.
- **Secrets:** keys, tokens and `.env` files are blocked before they leave the laptop.
- **Public API changes:** these need an answered owner decision.
- **Formatting:** fixed automatically, so whitespace noise never reaches a reviewer.
- **Lint, type check, and the tests related to the change.**

The developer sees only what needs action: the failing check, the evidence (file:line), and the fix.

### 3 · Review: everything merge would find, in one command

Before pushing, Pre-PR Guard runs what the PR review and CI would:

- **all tests in every mode, plus end-to-end tests** against the running app
- **test inventory:** a new test that silently skips a mode is caught
- **scope vs the card:** changed files outside the card are flagged
- **API contract:** an undeclared route, or a removed endpoint that would break old clients
- **migrations:** always a human decision
- **front-end:** accessibility basics and before/after screenshots
- **AI self-review and impact report** (below)

### 4 · AI self-review: an AI that has to show its evidence

Claude (Sonnet 5.5) reviews the diff against the card and a fixed checklist:
- silent failures
- fixes wider than the issue
- self-confirming tests
- missing test modes
- false or unsourced claims
- environment mismatch
- scope drift
- depending on another safety net

It also writes an **impact report** in plain words: behaviour before and after, who depends on it, what could break, and what to watch after merge.

The AI is not trusted by default:

| Guard | Effect |
|---|---|
| Strict JSON output | invalid answers are retried once, then reported as "not run" (never guessed) |
| Evidence must exist | every finding must quote a line that is really in a changed file, or it's dropped |
| Confidence floor | findings below 0.6 confidence are dropped, and the drops are shown |
| Sources for claims | "this library does X" needs an official docs link, or it's only "unverified" |
| No repeats | the AI sees what the deterministic checks already found |
| Privacy | code goes only to the approved provider; only token counts are stored |

### 5 · Ready: one verdict a reviewer can trust

| Verdict | Meaning |
|---|---|
| 🔴 **Not ready** | a serious finding, an unanswered decision, failing tests, or the wrong runtime |
| 🟡 **Ready with notes** | only minor findings, something didn't run, or the impact is unknown |
| 🟢 **Ready** | none of the above |

The readiness report maps each acceptance criterion to its tests, lists every check including the ones that **didn't run**, and states openly what was **not verified**. Results never carry over to newer code.

### Humans stay in charge

- **Owner decisions can't be bypassed.** A public API change, a contract break or a migration waits for the named owner.
- **Secrets can't be bypassed.** A pushed secret is leaked for good.
- **Everything else can be bypassed with a written reason**, including the AI's findings, because the AI is not the authority. The bypass covers one commit only, and the report says **who bypassed what and why**. Nothing is ever skipped silently.

---

## Demo results

A synthetic sign-up app (back-end API and front-end page) with one branch per known failure pattern:

| Seeded issue | Caught by | Result |
|---|---|---|
| Duplicate input silently dropped | test written from the requirement | 🔴 |
| Fix filters all errors, not only the reported case | regression test + scope check | 🔴 |
| New test excluded from one test mode | test inventory | 🔴 |
| Comment states a false fact about a library | AI, with a link to the Node.js docs | 🟡 |
| Tests run on a newer runtime than pinned | runtime check | 🔴 |
| Unrelated formatting change | auto-format + scope check | 🔴 |
| New public API with no owner decision | API flag | 🔴 |
| **Correct change** | no findings | 🟢 |

- **Catch rate:** 7 of 7 seeded issues, before the PR.
- **False alarms:** 0 on the correct change.
- **Speed:** commit checks ≈ 5–12 s (budget 30 s); full review including AI ≈ 25 s (budget 5 min); AI step 5–9 s, about $0.01–0.03 per review.

The end-to-end story branch shows the moment that matters. The developer's tests pass and the work "looks done", but one command finds a test missing from the legacy mode. Once that test runs there, it exposes a **real bug that would only have appeared after merge**. The AI also flags the same bug on its own, plus a comment that wrongly claims `decodeURIComponent` "never throws".

---

## Trust: earned with evidence, per kind of change

"Can we trust this?" gets an answer from the project's own history, not from a feeling. Every number links back to the commit that proves it.

### How an outcome is decided

| Outcome | Rule |
|---|---|
| **Worked perfectly** | no revert and no follow-up fix within 14 days |
| **Hit a defect** | a later fix from another task touched its files within 14 days |
| **Reverted** | a later revert names its commit |
| **Too recent** | the 14 days haven't passed; not counted either way |

### The metrics

| Metric | What it answers |
|---|---|
| **Trust ratio** = worked perfectly ÷ settled tasks | how often does this kind of change land cleanly? |
| **Defect rate** = (defects + reverts) ÷ settled tasks | how often did broken work reach `main`? |
| **95% lower bound** of the trust ratio | is the record proven, or a lucky streak? 5 out of 5 only proves "at least 57%" |
| **Trust level:** earned / building / not earned | **earned** = at least 5 tasks and a lower bound of 80% or more → fast accept allowed. **Not earned** → full human review |
| **Successes needed** | a concrete target: "+11 perfect PRs in a row" |
| **Before vs with Pre-PR Guard** | did it actually reduce failures? |
| **Per category** (back-end / front-end × AI-assisted / human) | trust is earned per kind of change, not globally |
| **Per developer** | PRs, worked perfectly, hit a defect, reverted, trust ratio. Used to choose review depth and pairing, never to rank people |
| **False-green rate** = 🟢 verdicts that later failed ÷ 🟢 verdicts | **can Pre-PR Guard itself be trusted?** |
| **Bypass outcomes** | did changes merged with a bypass hold up? |
| **Requirement coverage** | share of acceptance criteria proven by a passing test |
| **Developer time cost** | seconds added per commit and per review |

Trust moves both ways. One revert in an "earned" category drops its lower bound at once, and fast accept stops until the record recovers.

### Demo numbers (synthetic history: 79 tasks, 5 fictional developers)

**Before vs with Pre-PR Guard**

| | Tasks | Success | Reverted | Follow-up fixes |
|---|---|---|---|---|
| Before | 32 | 69% | 4 | 6 |
| With Pre-PR Guard | 44 | 95% | 1 | 1 |

**Failure rate 31% → 5%: 85% fewer failed tasks.**

**Per category (since adoption)**

| Category | Before | Now | 95% lower bound | Trust |
|---|---|---|---|---|
| back-end · human | 88% | 100% | 82% | **earned** |
| back-end · AI-assisted | 60% | 93% | 69% | building (+11) |
| front-end · AI-assisted | 50% | 88% | 53% | building (+17) |
| front-end · human | 83% | 100% | 51% | building (+12) |

**Per developer**

| Developer | PRs | Worked perfectly | Hit a defect | Reverted | Trust ratio | Trust |
|---|---|---|---|---|---|---|
| Dev Amber | 20 | 20 | 0 | 0 | 100% | **earned** |
| Dev Birch | 17 | 15 | 0 | 2 | 88% | building |
| Dev Cedar | 15 | 11 | 2 | 2 | 73% | not earned |
| Dev Dune | 14 | 10 | 3 | 1 | 71% | not earned |
| Dev Elm | 10 | 8 | 2 | 0 | 80% | building |

**Pre-PR Guard's own accuracy:** 1 false green out of 40 🟢 verdicts (3%). The single change merged anyway with a bypass later failed.

All of this appears in a local dashboard that's refreshed after every run: verdict, findings with evidence, impact, checks, trust statistics and recent runs.

---

## What the prototype covers today

**Built:**
- requirement cards and owner decisions
- fast commit checks with auto-format
- the full review: all test modes, e2e, inventory, scope, API contract, migrations, front-end checks
- AI self-review and impact report (Claude Sonnet 5.5)
- the readiness report and its rules
- bypass rules
- trust metrics from git history
- the HTML dashboard
- a synthetic demo repo with 9 scenario branches

**Next:**
- the AI drafts the requirement card and the tests from it
- the "in reach" check: the AI refuses or asks for a checkpoint when a task is outside what it can verify
- the shift-left curve: where each issue was caught
- local-vs-CI agreement
- AI calibration and impact-prediction accuracy
- a pilot against a 2-week baseline on a real team

**Out of scope by design:** changing the existing PR review process, merge rules or CI bots.
