import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectIssues } from '../api/issues.js';
import { buildReport } from '../api/report.js';

test('local issues are reported with file and line', () => {
  const issues = collectIssues({ local: [{ message: 'Missing email', location: { file: 'attendees.csv', line: 4 } }] });
  assert.deepEqual(buildReport(issues), ['[local] Missing email (attendees.csv:4)']);
});

test('file-level local issues are reported with the file only', () => {
  const issues = collectIssues({ local: [{ message: 'Header row missing', location: { file: 'attendees.csv', line: null } }] });
  assert.deepEqual(buildReport(issues), ['[local] Header row missing (attendees.csv)']);
});
