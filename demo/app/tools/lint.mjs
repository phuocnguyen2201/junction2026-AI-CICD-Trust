#!/usr/bin/env node
// Synthetic stand-in for a linter (think eslint). Rules: no-var, no-debugger, no-console (api/ and web/ only,
// except api/server.js). Usage: node tools/lint.mjs [files...]   (no files = all tracked .js/.mjs)

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

let files = process.argv.slice(2);
if (!files.length) files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
files = files.filter((f) => /\.m?js$/.test(f) && fs.existsSync(f));

const RULES = [
  { id: 'no-var', re: /^\s*(export\s+)?var\s+[\w$]/, msg: 'use let/const instead of var', applies: () => true },
  { id: 'no-debugger', re: /^\s*debugger\s*;?\s*$/, msg: 'remove debugger statement', applies: () => true },
  { id: 'no-console', re: /\bconsole\.(log|debug|info)\(/, msg: 'no console logging in app code', applies: (f) => /^(api|web)\//.test(f) && f !== 'api/server.js' },
];

let count = 0;
for (const f of files) {
  fs.readFileSync(f, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      for (const r of RULES) {
        const m = r.applies(f) && r.re.exec(line);
        if (m) {
          count++;
          console.log(`${f}:${i + 1}:${m.index + 1}  ${r.id}  ${r.msg}`);
        }
      }
    });
}
if (count) {
  console.log(`${count} problem(s)`);
  process.exit(1);
}
