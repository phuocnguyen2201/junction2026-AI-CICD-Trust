// HTTP wiring for local runs: `node api/server.js`, then open http://localhost:3000.

import http from 'node:http';
import fs from 'node:fs';
import { createApp } from './routes.js';

const app = createApp();
const STATIC = { '/': 'web/index.html', '/app.js': 'web/app.js', '/format.js': 'web/format.js' };

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && STATIC[req.url]) {
    const type = req.url === '/' ? 'text/html' : 'text/javascript';
    res.writeHead(200, { 'content-type': type });
    res.end(fs.readFileSync(STATIC[req.url]));
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }
    const out = app.handle({ method: req.method, path: req.url, body });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
});

server.listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`listening on ${server.address().port}`);
});
