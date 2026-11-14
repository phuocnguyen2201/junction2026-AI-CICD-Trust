import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/routes.js';

test('POST /attendees creates an attendee', () => {
  const app = createApp();
  const res = app.handle({ method: 'POST', path: '/attendees', body: { name: 'Ada', email: 'ada@example.test' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Ada');
});

test('POST /attendees rejects invalid input with issues', () => {
  const app = createApp();
  const res = app.handle({ method: 'POST', path: '/attendees', body: { name: '', email: 'nope' } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.issues.map((i) => i.code), ['missing_name', 'invalid_email']);
});

test('GET /attendees lists attendees', () => {
  const app = createApp();
  app.handle({ method: 'POST', path: '/attendees', body: { name: 'Ada', email: 'ada@example.test' } });
  const res = app.handle({ method: 'GET', path: '/attendees' });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('unknown routes return 404', () => {
  const app = createApp();
  assert.equal(app.handle({ method: 'GET', path: '/nope' }).status, 404);
});
