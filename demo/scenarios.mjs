// Seeded demo branches, one per known failure pattern (synthetic code only).
// Each scenario: a requirement card + tests drafted from it (commit 1, before code),
// then the "AI-written" change (commit 2) that carries the seeded issue.
//
// File values: string = write file, null = delete, edit(from, to) = patch existing file.

export const edit = (...pairs) => ({ edits: pairs });
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

const LEGACY = 'test/store.test.js test/routes.test.js test/report.test.js test/web-format.test.js';
/** Patch package.json so the legacy test mode also runs these files. */
const addToLegacy = (...files) => edit([LEGACY, `${LEGACY} ${files.join(' ')}`]);

function card(c) {
  return (
    JSON.stringify(
      {
        layers: ['backend'],
        risk_tier: 'medium',
        in_reach: { result: 'do', signals_failed: [] },
        open_decisions: [],
        ...c,
      },
      null,
      2,
    ) + '\n'
  );
}

export const scenarios = [
  // 1 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/silent-drop',
    pattern: 'Duplicate input silently dropped',
    caughtBy: 'Test from requirement (§7.2)',
    expect: { check: 'fail', ready: 'red' },
    commits: [
      {
        message: 'DEMO-101: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-101.json': card({
            id: 'DEMO-101',
            title: 'Reject duplicate sign-ups by email',
            acceptance_criteria: [
              'A second sign-up with an email that is already registered (any letter case) is rejected with HTTP 409 and error "duplicate_email"',
              'The existing attendee is left unchanged',
              'Sign-ups with different emails are still accepted',
            ],
            scope: {
              in: ['duplicate detection on POST /attendees'],
              out: ['changing the attendee data model', 'front-end changes'],
              paths: { in: ['api/store.js', 'api/routes.js', 'test/**', 'package.json'] },
            },
            expected_blast_radius: 'POST /attendees; every client that signs people up',
          }),
          'test/duplicates.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/routes.js';

const post = (app, body) => app.handle({ method: 'POST', path: '/attendees', body });

test('AC1: a second sign-up with the same email is rejected with 409 duplicate_email', () => {
  const app = createApp();
  post(app, { name: 'Ada', email: 'ada@example.test' });
  const res = post(app, { name: 'Ada L.', email: 'ADA@example.test' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'duplicate_email');
});

test('AC2: the existing attendee is left unchanged', () => {
  const app = createApp();
  post(app, { name: 'Ada', email: 'ada@example.test' });
  post(app, { name: 'Someone else', email: 'ada@example.test' });
  const list = app.handle({ method: 'GET', path: '/attendees' }).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Ada');
});

test('AC3 (regression): different emails are still accepted', () => {
  const app = createApp();
  assert.equal(post(app, { name: 'Ada', email: 'ada@example.test' }).status, 201);
  assert.equal(post(app, { name: 'Grace', email: 'grace@example.test' }).status, 201);
});
`,
          'package.json': addToLegacy('test/duplicates.test.js'),
        },
      },
      {
        message: 'DEMO-101: handle duplicate emails',
        files: {
          'api/store.js': edit([
            `    add(input) {
      const id`,
            `    add(input) {
      const existing = this.findByEmail(input.email);
      if (existing) return existing; // already registered, nothing to do
      const id`,
          ]),
          'test/store.test.js': edit([
            `test('findByEmail ignores case'`,
            `test('adding the same email twice keeps a single entry', () => {
  const store = createStore();
  store.add({ name: 'Ada', email: 'ada@example.test' });
  store.add({ name: 'Ada', email: 'ada@example.test' });
  assert.equal(store.list().length, 1);
});

test('findByEmail ignores case'`,
          ]),
        },
      },
    ],
  },

  // 2 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/too-wide',
    pattern: 'Fix filters all errors, not only the reported case',
    caughtBy: 'Regression test + scope check',
    expect: { check: 'fail', ready: 'red' },
    commits: [
      {
        message: 'DEMO-102: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-102.json': card({
            id: 'DEMO-102',
            title: 'Data-quality report crashes on imported issues without a location',
            acceptance_criteria: [
              'GET /issues no longer crashes when an imported partner issue has no location',
              'Local issues, including file-level ones (line = null), are still reported exactly as before',
            ],
            scope: {
              in: ['imported issues that have no location'],
              out: ['local issues', 'the shared issue collector (api/issues.js) used by other features'],
              paths: { in: ['api/report.js', 'test/**', 'package.json'], out: ['api/issues.js'] },
            },
            expected_blast_radius: 'data-quality report (GET /issues)',
            open_decisions: [
              {
                id: 'D-1',
                question: 'Show imported issues without a location, or hide them?',
                why_not_ai: 'owner_intent',
                owner_role: 'data-quality report owners',
                answer: 'Show them, marked "(no location)". Never drop local issues.',
              },
            ],
          }),
          'test/report-imported.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectIssues } from '../api/issues.js';
import { buildReport } from '../api/report.js';

const imported = [{ message: 'Unknown ticket type' }];
const fileLevel = { message: 'Header row missing', location: { file: 'attendees.csv', line: null } };

test('AC1: an imported issue without a location does not crash the report', () => {
  assert.doesNotThrow(() => buildReport(collectIssues({ imported })));
});

test('AC2 (regression): file-level local issues are still reported next to imported ones', () => {
  const report = buildReport(collectIssues({ local: [fileLevel], imported }));
  assert.ok(report.includes('[local] Header row missing (attendees.csv)'), JSON.stringify(report));
});
`,
          'package.json': addToLegacy('test/report-imported.test.js'),
        },
      },
      {
        message: 'DEMO-102: fix crash on issues without location',
        files: {
          'api/issues.js': edit([
            `  return [
    ...local.map((i) => ({ ...i, source: 'local' })),
    ...imported.map((i) => ({ ...i, source: 'imported' })),
  ];`,
            `  // Skip issues without a precise location so the report can always format them.
  return [
    ...local.map((i) => ({ ...i, source: 'local' })),
    ...imported.map((i) => ({ ...i, source: 'imported' })),
  ].filter((i) => i.location && i.location.line !== null);`,
          ]),
        },
      },
    ],
  },

  // 3 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/missing-mode',
    pattern: 'New test excluded from one test mode',
    caughtBy: 'Test inventory (§8.2)',
    expect: { check: 'pass', ready: 'red' },
    commits: [
      {
        message: 'DEMO-103: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-103.json': card({
            id: 'DEMO-103',
            title: 'Show the attendee count in the page header',
            layers: ['frontend'],
            risk_tier: 'low',
            acceptance_criteria: [
              'The header shows "No attendees yet", "1 attendee" or "N attendees"',
              'The count updates after each sign-up',
            ],
            scope: {
              in: ['sign-up page header'],
              out: ['API changes'],
              paths: { in: ['web/**', 'test/**'] },
            },
            expected_blast_radius: 'sign-up page header only',
          }),
          'test/web-count.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCount } from '../web/format.js';

test('AC1: count label for 0, 1 and many attendees', () => {
  assert.equal(formatCount(0), 'No attendees yet');
  assert.equal(formatCount(1), '1 attendee');
  assert.equal(formatCount(3), '3 attendees');
});
`,
        },
      },
      {
        message: 'DEMO-103: attendee count in header',
        files: {
          'web/format.js': edit([
            `export function formatErrors`,
            `export function formatCount(n) {
  if (n === 0) return 'No attendees yet';
  return n === 1 ? '1 attendee' : \`\${n} attendees\`;
}

export function formatErrors`,
          ]),
          'web/app.js': edit(
            [`import { formatAttendee, formatErrors } from './format.js';`, `import { formatAttendee, formatCount, formatErrors } from './format.js';`],
            [`const error = document.getElementById('error');`, `const error = document.getElementById('error');\nconst title = document.getElementById('title');`],
            [`  const attendees = await res.json();\n`, `  const attendees = await res.json();\n  title.textContent = \`Event sign-up · \${formatCount(attendees.length)}\`;\n`],
          ),
        },
      },
    ],
  },

  // 4 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/false-claim',
    pattern: 'Code comment states a false fact about a library',
    caughtBy: 'Unsourced claim check (§7.3)',
    expect: { check: 'pass', ready: 'yellow', needsAi: true },
    commits: [
      {
        message: 'DEMO-104: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-104.json': card({
            id: 'DEMO-104',
            title: 'Callers must not be able to change stored attendees',
            risk_tier: 'low',
            acceptance_criteria: ['Changing an attendee returned by GET /attendees does not change the stored attendee'],
            scope: {
              in: ['store.list() return value'],
              out: ['API shape'],
              paths: { in: ['api/store.js', 'test/**', 'package.json'] },
            },
            expected_blast_radius: 'GET /attendees response objects',
          }),
          'test/store-copy.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../api/store.js';

test('AC1: changing a listed attendee does not change the store', () => {
  const store = createStore();
  store.add({ name: 'Ada', email: 'ada@example.test' });
  store.list()[0].name = 'Mallory';
  assert.equal(store.list()[0].name, 'Ada');
});
`,
          'package.json': addToLegacy('test/store-copy.test.js'),
        },
      },
      {
        message: 'DEMO-104: return copies from list()',
        files: {
          'api/store.js': edit([
            `      return attendees.slice();`,
            `      // structuredClone() is not available in Node.js before v22, so deep-copy via JSON instead.
      return JSON.parse(JSON.stringify(attendees));`,
          ]),
        },
      },
    ],
  },

  // 5 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/env-mismatch',
    pattern: 'Tests run on a newer runtime than pinned',
    caughtBy: 'Pinned env check (§8.1)',
    expect: { check: 'fail', ready: 'red' },
    commits: [
      {
        message: 'DEMO-105: requirement card',
        files: {
          'requirements/DEMO-105.json': card({
            id: 'DEMO-105',
            title: `Pin the runtime to the production Node version (${NODE_MAJOR - 2})`,
            risk_tier: 'low',
            acceptance_criteria: [`The repo pins Node ${NODE_MAJOR - 2}, the version production runs`, 'All tests pass on the pinned version'],
            scope: { in: ['runtime pin'], out: ['code changes'], paths: { in: ['.nvmrc', 'README.md'] } },
            expected_blast_radius: 'every developer machine and CI job',
          }),
        },
      },
      {
        message: `DEMO-105: pin Node ${NODE_MAJOR - 2}`,
        files: {
          '.nvmrc': `${NODE_MAJOR - 2}\n`,
          'README.md': edit(['Runtime: Node (see `.nvmrc`).', `Runtime: Node ${NODE_MAJOR - 2} (see \`.nvmrc\`), same as production.`]),
        },
      },
    ],
  },

  // 6 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/scope-noise',
    pattern: 'Unrelated formatting change',
    caughtBy: 'Auto-format + scope check',
    expect: { check: 'fail', ready: 'red' },
    commits: [
      {
        message: 'DEMO-106: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-106.json': card({
            id: 'DEMO-106',
            title: 'Missing-name message should read "Name is required"',
            risk_tier: 'low',
            acceptance_criteria: ['POST /attendees without a name returns the issue message "Name is required"'],
            scope: { in: ['validation message text'], out: ['front-end', 'validation rules'], paths: { in: ['api/validate.js', 'test/**', 'package.json'] } },
            expected_blast_radius: 'error text shown on the sign-up page',
          }),
          'test/validate.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAttendee } from '../api/validate.js';

test('AC1: missing name says "Name is required"', () => {
  const [issue] = validateAttendee({ name: '', email: 'ada@example.test' });
  assert.equal(issue.code, 'missing_name');
  assert.equal(issue.message, 'Name is required');
});
`,
          'package.json': addToLegacy('test/validate.test.js'),
        },
      },
      {
        message: 'DEMO-106: update missing-name message',
        files: {
          'api/validate.js': edit([`message: 'Name missing'`, `message: 'Name is required'`]),
          // Editor re-indented an unrelated file with tabs and left trailing spaces.
          'web/app.js': (text) =>
            text
              .split('\n')
              .map((l) => l.replace(/^( {2})+/, (m) => '\t'.repeat(m.length / 2)))
              .map((l, i) => (i % 7 === 3 && l.trim() ? `${l}  ` : l))
              .join('\n'),
        },
      },
    ],
  },

  // 7 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/api-change',
    pattern: 'New public API with no decision',
    caughtBy: 'API change flag → 🔴',
    expect: { check: 'fail', ready: 'red' },
    commits: [
      {
        message: 'DEMO-107: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-107.json': card({
            id: 'DEMO-107',
            title: 'Let organisers remove an attendee',
            risk_tier: 'high',
            acceptance_criteria: ['An organiser can remove an attendee by id', 'Removing an unknown id returns 404'],
            scope: { in: ['remove attendee'], out: ['authentication of organisers'], paths: { in: ['api/**', 'test/**', 'package.json'] } },
            expected_blast_radius: 'public API: new endpoint; all API clients',
            in_reach: { result: 'do_with_checkpoint', signals_failed: ['blast_radius'], needed_to_continue: 'API owners decide the endpoint shape first' },
            open_decisions: [
              {
                id: 'D-1',
                question: 'Add DELETE /attendees/:id as a public endpoint? Hard or soft delete, and how do legacy numeric ids map?',
                why_not_ai: 'long_term_promise',
                owner_role: 'API owners',
                trigger: 'public_api_change',
                where: 'api/contract.json',
                answer: null,
              },
            ],
          }),
          'test/remove.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/routes.js';

test('AC1: an attendee can be removed by id', () => {
  const app = createApp();
  const a = app.handle({ method: 'POST', path: '/attendees', body: { name: 'Ada', email: 'ada@example.test' } }).body;
  assert.equal(app.handle({ method: 'DELETE', path: \`/attendees/\${a.id}\` }).status, 204);
  assert.equal(app.handle({ method: 'GET', path: '/attendees' }).body.length, 0);
});

test('AC2: removing an unknown id returns 404', () => {
  const app = createApp();
  assert.equal(app.handle({ method: 'DELETE', path: '/attendees/nope' }).status, 404);
});
`,
          'package.json': addToLegacy('test/remove.test.js'),
        },
      },
      {
        message: 'DEMO-107: DELETE /attendees/:id',
        files: {
          'api/store.js': edit([
            `    findByEmail(email) {`,
            `    remove(id) {
      const i = attendees.findIndex((a) => String(a.id) === String(id));
      if (i === -1) return false;
      attendees.splice(i, 1);
      return true;
    },
    findByEmail(email) {`,
          ]),
          'api/routes.js': edit(
            [
              `    {
      method: 'GET',
      path: '/issues',`,
              `    {
      method: 'DELETE',
      path: '/attendees/:id',
      handler: ({ params }) => (store.remove(params.id) ? { status: 204, body: null } : { status: 404, body: { error: 'not_found' } }),
    },
    {
      method: 'GET',
      path: '/issues',`,
            ],
            [
              `  function handle({ method, path, body }) {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) return { status: 404, body: { error: 'not_found' } };
    return route.handler({ body });
  }`,
              `  function match(pattern, path) {
    const a = pattern.split('/');
    const b = path.split('/');
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) return null;
    }
    return params;
  }

  function handle({ method, path, body }) {
    for (const route of routes) {
      const params = route.method === method ? match(route.path, path) : null;
      if (params) return route.handler({ body, params });
    }
    return { status: 404, body: { error: 'not_found' } };
  }`,
            ],
          ),
          'api/contract.json': edit([
            `    {
      "method": "GET",
      "path": "/issues",`,
            `    {
      "method": "DELETE",
      "path": "/attendees/:id",
      "response": "204 | 404 { error }"
    },
    {
      "method": "GET",
      "path": "/issues",`,
          ]),
        },
      },
    ],
  },

  // 9 ── the end-to-end story (several patterns at once, see demo/STORY.md) ─────
  {
    branch: 'demo/feature-done',
    pattern: 'Developer says "done": tests pass, but 4 merge-time issues are hidden',
    caughtBy: 'preguard review → ready',
    story: true,
    expect: { check: 'fail', ready: 'red' },
    commits: [
      {
        message: 'DEMO-201: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-201.json': card({
            id: 'DEMO-201',
            title: 'Organisers can remove an attendee',
            risk_tier: 'high',
            acceptance_criteria: [
              'DELETE /attendees/:id removes that attendee and returns 204',
              'Removing an unknown id returns 404',
              'Other attendees are left untouched',
            ],
            scope: {
              in: ['remove attendee endpoint'],
              out: ['front-end', 'organiser authentication'],
              paths: { in: ['api/store.js', 'api/routes.js', 'api/contract.json', 'test/**', 'package.json'] },
            },
            expected_blast_radius: 'public API: new endpoint; every API client, both id formats',
            in_reach: { result: 'do_with_checkpoint', signals_failed: ['blast_radius'], needed_to_continue: 'API owners decide the endpoint shape' },
            open_decisions: [
              {
                id: 'D-1',
                question: 'Add DELETE /attendees/:id as a public endpoint (hard delete)?',
                why_not_ai: 'long_term_promise',
                owner_role: 'API owners',
                trigger: 'public_api_change',
                where: 'api/contract.json',
                answer: null,
              },
            ],
          }),
          'test/remove.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/routes.js';

const post = (app, name, email) => app.handle({ method: 'POST', path: '/attendees', body: { name, email } }).body;
const list = (app) => app.handle({ method: 'GET', path: '/attendees' }).body;

test('AC1: DELETE /attendees/:id removes the attendee and returns 204', () => {
  const app = createApp();
  const a = post(app, 'Ada', 'ada@example.test');
  assert.equal(app.handle({ method: 'DELETE', path: \`/attendees/\${a.id}\` }).status, 204);
  assert.equal(list(app).length, 0);
});

test('AC2: removing an unknown id returns 404', () => {
  assert.equal(createApp().handle({ method: 'DELETE', path: '/attendees/999' }).status, 404);
});

test('AC3 (regression): other attendees are left untouched', () => {
  const app = createApp();
  const a = post(app, 'Ada', 'ada@example.test');
  post(app, 'Grace', 'grace@example.test');
  app.handle({ method: 'DELETE', path: \`/attendees/\${a.id}\` });
  assert.deepEqual(list(app).map((x) => x.name), ['Grace']);
});
`,
        },
      },
      {
        message: 'DEMO-201: DELETE /attendees/:id',
        files: {
          'api/store.js': edit([
            `    findByEmail(email) {`,
            `    remove(id) {
      const i = attendees.findIndex((a) => a.id === id);
      if (i === -1) return false;
      attendees.splice(i, 1);
      return true;
    },
    findByEmail(email) {`,
          ]),
          'api/routes.js': edit(
            [
              `    {
      method: 'GET',
      path: '/issues',`,
              `    {
      method: 'DELETE',
      path: '/attendees/:id',
      handler: ({ params }) => (store.remove(params.id) ? { status: 204, body: null } : { status: 404, body: { error: 'not_found' } }),
    },
    {
      method: 'GET',
      path: '/issues',`,
            ],
            [
              `  function handle({ method, path, body }) {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) return { status: 404, body: { error: 'not_found' } };
    return route.handler({ body });
  }`,
              `  function match(pattern, path) {
    const a = pattern.split('/');
    const b = path.split('/');
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < a.length; i++) {
      // decodeURIComponent never throws on path input, so no try/catch is needed here.
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) return null;
    }
    return params;
  }

  function handle({ method, path, body }) {
    for (const route of routes) {
      const params = route.method === method ? match(route.path, path) : null;
      if (params) return route.handler({ body, params });
    }
    return { status: 404, body: { error: 'not_found' } };
  }`,
            ],
          ),
          'api/contract.json': edit([
            `    {
      "method": "GET",
      "path": "/issues",`,
            `    {
      "method": "DELETE",
      "path": "/attendees/:id",
      "response": "204 | 404 { error }"
    },
    {
      "method": "GET",
      "path": "/issues",`,
          ]),
          // Editor re-indented an unrelated front-end file.
          'web/app.js': (text) => text.split('\n').map((l) => l.replace(/^( {2})+/, (m) => '\t'.repeat(m.length / 2))).join('\n'),
        },
      },
    ],
  },

  // 8 ────────────────────────────────────────────────────────────────────────
  {
    branch: 'demo/clean',
    pattern: 'Correct change',
    caughtBy: '🟢 Ready',
    expect: { check: 'pass', ready: 'green', needsAi: true },
    commits: [
      {
        message: 'DEMO-108: requirement card + tests from acceptance criteria',
        files: {
          'requirements/DEMO-108.json': card({
            id: 'DEMO-108',
            title: 'Trim surrounding spaces from names and emails on sign-up',
            risk_tier: 'low',
            acceptance_criteria: [
              'A name like "  Ada  " is saved as "Ada"',
              'An email with surrounding spaces is accepted and saved without them',
              'A name made only of spaces is still rejected as missing_name',
            ],
            scope: { in: ['input normalisation on POST /attendees'], out: ['validation rules', 'front-end'], paths: { in: ['api/validate.js', 'api/routes.js', 'test/**', 'package.json'] } },
            expected_blast_radius: 'POST /attendees input handling',
          }),
          'test/trim.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/routes.js';

const post = (app, body) => app.handle({ method: 'POST', path: '/attendees', body });

test('AC1: surrounding spaces are trimmed from the name', () => {
  const res = post(createApp(), { name: '  Ada  ', email: 'ada@example.test' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Ada');
});

test('AC2: an email with surrounding spaces is accepted and trimmed', () => {
  const res = post(createApp(), { name: 'Ada', email: ' ada@example.test ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.email, 'ada@example.test');
});

test('AC3 (regression): a name of only spaces is still rejected', () => {
  const res = post(createApp(), { name: '   ', email: 'ada@example.test' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.issues.map((i) => i.code), ['missing_name']);
});
`,
          'package.json': addToLegacy('test/trim.test.js'),
        },
      },
      {
        message: 'DEMO-108: trim name and email before validation',
        files: {
          'api/validate.js': edit([
            `export function validateAttendee(input) {`,
            `export function normalizeAttendee(input) {
  if (!input || typeof input !== 'object') return input;
  const trim = (v) => (typeof v === 'string' ? v.trim() : v);
  return { ...input, name: trim(input.name), email: trim(input.email) };
}

export function validateAttendee(input) {`,
          ]),
          'api/routes.js': edit(
            [`import { validateAttendee } from './validate.js';`, `import { normalizeAttendee, validateAttendee } from './validate.js';`],
            [
              `      handler: ({ body }) => {
        const issues = validateAttendee(body);
        if (issues.length) return { status: 400, body: { error: 'invalid_input', issues } };
        return { status: 201, body: store.add(body) };`,
              `      handler: ({ body }) => {
        const input = normalizeAttendee(body);
        const issues = validateAttendee(input);
        if (issues.length) return { status: 400, body: { error: 'invalid_input', issues } };
        return { status: 201, body: store.add(input) };`,
            ],
          ),
        },
      },
    ],
  },
];
