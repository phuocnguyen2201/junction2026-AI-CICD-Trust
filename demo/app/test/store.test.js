import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../api/store.js';

test('add stores the attendee with a lower-cased email', () => {
  const store = createStore();
  const a = store.add({ name: 'Ada', email: 'ADA@example.test' });
  assert.equal(a.email, 'ada@example.test');
  assert.ok(a.id !== undefined);
  assert.deepEqual(store.list(), [a]);
});

test('ids follow the active id format', () => {
  const store = createStore();
  const a = store.add({ name: 'Ada', email: 'ada@example.test' });
  if (process.env.ID_FORMAT === 'legacy') assert.equal(typeof a.id, 'number');
  else assert.match(a.id, /^att_\d+$/);
});

test('findByEmail ignores case', () => {
  const store = createStore();
  const a = store.add({ name: 'Ada', email: 'ada@example.test' });
  assert.equal(store.findByEmail('Ada@Example.test'), a);
  assert.equal(store.findByEmail('nobody@example.test'), null);
});
