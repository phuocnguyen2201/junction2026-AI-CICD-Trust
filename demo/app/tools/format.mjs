#!/usr/bin/env node
// Synthetic stand-in for a formatter (think prettier --check / --write).
// Rules: LF line endings, 2-space indentation (no tabs), no trailing whitespace, one final newline.
// Usage: node tools/format.mjs --check|--write [files...]   (no files = all tracked text files)

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const TEXT = /\.(m?js|json|html|css|md)$/;
const args = process.argv.slice(2);
const write = args.includes('--write');
let files = args.filter((a) => !a.startsWith('--'));
if (!files.length) files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
files = files.filter((f) => TEXT.test(f) && fs.existsSync(f));

function format(text) {
  let out = text.replace(/\r\n/g, '\n');
  out = out
    .split('\n')
    .map((line) => {
      const m = /^[\t ]*/.exec(line)[0];
      const indent = m.replace(/\t/g, '  ');
      return (indent + line.slice(m.length)).replace(/[ \t]+$/, '');
    })
    .join('\n');
  return out.replace(/\n*$/, '\n');
}

function problems(text) {
  const out = [];
  if (text.includes('\r\n')) out.push([1, 'CRLF line endings']);
  text.split('\n').forEach((line, i) => {
    if (/^[ ]*\t/.test(line)) out.push([i + 1, 'tab indentation (use 2 spaces)']);
    if (/[ \t]+$/.test(line)) out.push([i + 1, 'trailing whitespace']);
  });
  if (!text.endsWith('\n') || text.endsWith('\n\n')) out.push([text.split('\n').length, 'file must end with exactly one newline']);
  return out;
}

let bad = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const formatted = format(text);
  if (formatted === text) continue;
  bad++;
  if (write) {
    fs.writeFileSync(f, formatted);
    console.log(`formatted ${f}`);
  } else {
    for (const [line, msg] of problems(text)) console.log(`${f}:${line}: ${msg}`);
  }
}
if (!write && bad) {
  console.log(`${bad} file(s) need formatting. Run: node tools/format.mjs --write <files>`);
  process.exit(1);
}
