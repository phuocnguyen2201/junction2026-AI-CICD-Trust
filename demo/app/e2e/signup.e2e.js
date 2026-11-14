// End-to-end: starts the real server on a free port and drives it over HTTP, like the browser would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

let server;
let base;

before(async () => {
  server = spawn(process.execPath, ['api/server.js'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const m = /listening on (\d+)/.exec(String(d));
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => server.kill());

const post = (body) => fetch(`${base}/attendees`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('E2E: the sign-up page and its scripts are served', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1 id="title">Event sign-up<\/h1>/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
});

test('E2E: a visitor signs up and appears in the list', async () => {
  const res = await post({ name: 'Ada', email: 'ada@example.test' });
  assert.equal(res.status, 201);
  const list = await (await fetch(`${base}/attendees`)).json();
  assert.ok(list.some((a) => a.email === 'ada@example.test'));
});

test('E2E: an invalid sign-up shows the validation issues', async () => {
  const res = await post({ name: '', email: 'nope' });
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).issues.map((i) => i.code), ['missing_name', 'invalid_email']);
});
