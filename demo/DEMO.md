# Demo: change the code → review without AI → review with AI

**Story (about 5 minutes):** a developer makes a small, reasonable-looking change. Tests pass, the commit checks pass, and the full review **without AI** says OK. Then the same review **with AI** finds what no test can see: a comment that states a false fact about the platform and justifies the wrong design. The developer fixes it, and the verdict goes 🟡 → 🟢.

Everything runs locally on synthetic code. Nothing is pushed.

---

**Starting point:** you're in the project on branch `feature/DEMO-104-safe-copies`. The requirement card and its test exist; the code change doesn't yet. Pre-PR Guard is set up, with the git hooks installed and the AI enabled. Have `api/store.js` and `requirements/DEMO-104.json` open in the editor.

---

## 1. The task (30 s)

Show `requirements/DEMO-104.json`:

> **DEMO-104: Callers must not be able to change stored attendees.**
> AC1: Changing an attendee returned by GET /attendees does not change the stored attendee.

The test was written from that criterion **before** the code:

```sh
node --test test/store-copy.test.js        # ℹ fail 1: the code doesn't exist yet
```

> "Tests first, from the requirement. Right now it fails, as it should."

## 2. Change the code (30 s)

In `api/store.js`, inside `list()`, replace

```js
      return attendees.slice();
```

with

```js
      // structuredClone() is not available in Node.js before v22, so deep-copy via JSON instead.
      return JSON.parse(JSON.stringify(attendees));
```

(No time to type? Run this instead:
`node -e 'const f="api/store.js",fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("      return attendees.slice();","      // structuredClone() is not available in Node.js before v22, so deep-copy via JSON instead.\n      return JSON.parse(JSON.stringify(attendees));"))'`)

```sh
npm run --silent test:default              # ℹ pass 12, fail 0
```

> "The tests pass. The code works. It looks done."

## 3. Commit: the fast checks run by themselves (20 s)

```sh
git commit -am "DEMO-104: return copies from list()"
```

```
✔ 7 passed: pinned env, secret scan, public API flag, format, lint, type check, related tests
OK · DEMO-104 · 1 file(s) · 12s
```

> "The commit hook checked the runtime pin, secrets, API changes, formatting, lint, types and the related tests. All green."

## 4. Full review WITHOUT AI (45 s)

```sh
preguard review --no-ai
```

```
○ AI self-review  not run: AI turned off for this run (--no-ai)
○ impact report   not run: impact unknown: AI turned off for this run (--no-ai)
✔ 15 passed: pinned env, secret scan, public API flag, format, lint, type check, all tests (every mode),
             end-to-end tests, test inventory, scope vs card, API contract, migrations,
             accessibility basics, before/after screens, critical flows
OK · DEMO-104 · 4 file(s) vs main · 15s
```

> "One command runs everything CI and the review would: every test mode, the end-to-end tests against the running app, the scope against the card, the API contract. Everything passes. Notice the AI steps say **not run**. We never hide what we skipped."

## 5. Turn the AI on (60 s)

The AI is enabled in the shared rule pack. Show it:

```sh
grep -A3 "^ai:" .preguard/rules.yml
```

```yaml
ai:
  provider: anthropic
  model: claude-sonnet-5-5
  send_code: true
```

> "Code only goes to the provider approved in this file. Set `send_code: false` and nothing is ever sent. The key stays outside the repo."

Run the same review, now with AI:

```sh
preguard review
```

```
▲ AI self-review  1 finding(s): unsourced_claims (claude-sonnet-5-5, 5 s, 3925→490 tokens)
✔ 16 passed: … impact report
AI findings (checked: evidence exists at file:line)
  ● api/store.js:17  The comment says structuredClone() is unavailable before Node.js v22, which is false.
                     It was added in Node.js v17.0.0, so the stated reason for using JSON copying is misleading.
    // structuredClone() is not available in Node.js before v22, so deep-copy via JSON instead.
    https://nodejs.org/api/globals.html#structuredclonevalue-options
OK · DEMO-104 · 4 file(s) vs main · 21s
```

> "Every test passed, because the code runs. But the comment is false, and it drove the design: JSON copying silently turns dates into strings. No test can catch a false claim. A reviewer might, a week from now. The AI caught it in 5 seconds, quoted the exact line and linked the official docs. If it can't quote a line that really exists in the change, we drop the finding."

## 6. Readiness verdict (30 s)

```sh
preguard ready
```

```
🟡 Ready with notes  1 low/medium finding(s); warnings: AI self-review
  track record (backend · human): 18/18 succeeded (100%, 95% lower bound 82%) → trust earned
Record it in the final commit message: Preguard-Status: yellow
```

> "Not blocked, because it's a medium finding, but not green. And the track record for this kind of change comes from the repo's own history."

## 7. Fix it and get to green (45 s)

Replace the two lines in `api/store.js` with:

```js
      return structuredClone(attendees);
```

```sh
git commit -am "DEMO-104: copy with structuredClone (AI review)"
preguard ready
```

```
🟢 Ready  all checks passed, impact known, no open decisions
  fixed since last report: 1 finding(s)
Record it in the final commit message: Preguard-Status: green
```

## 8. Show the dashboard (45 s)

```sh
preguard report --open
```

On the page, show:
- the 🟢 verdict, and the finding marked **fixed**
- the AI's impact report: before → after, who depends on it, what could break
- every check, including what didn't run
- **Trust:** failure rate before vs with Pre-PR Guard (31% → 5%), trust per category, per developer, and Pre-PR Guard's own false-green rate (1 of 40)
- **Recent runs:** the without-AI review, the with-AI review, and both `ready` runs, each with a snapshot

> "Without AI: fast, deterministic, nothing hidden. With AI: it finds what tests can't, but only with evidence. And whether to trust any of it is a number from the project's own history."

---

**Longer version** (a missing test mode hides a real bug, an owner decision, a bypass): see [STORY.md](STORY.md).
