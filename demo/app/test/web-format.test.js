import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAttendee, formatErrors } from '../web/format.js';

test('formatAttendee shows name and email', () => {
  assert.equal(formatAttendee({ name: 'Ada', email: 'ada@example.test' }), 'Ada <ada@example.test>');
});

test('formatErrors joins issue messages', () => {
  assert.equal(formatErrors([{ message: 'Name missing' }, { message: 'Email is not valid' }]), 'Name missing. Email is not valid');
});
