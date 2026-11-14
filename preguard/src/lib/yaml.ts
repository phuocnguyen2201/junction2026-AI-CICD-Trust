// Minimal YAML subset parser/emitter for the rule pack (no dependencies).
// Supports: block maps, block lists (incl. lists of maps), flow lists [a, "b"],
// empty flow maps {}, quoted/unquoted scalars, numbers, booleans, null, comments.
// Anything outside this subset throws a YamlError with the line number.

export class YamlError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`YAML line ${line}: ${message}`);
    this.line = line;
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function tokenize(src: string): Line[] {
  const out: Line[] = [];
  src.split(/\r?\n/).forEach((raw, idx) => {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) return;
    const noComment = stripComment(raw).replace(/\s+$/, '');
    if (!noComment.trim()) return;
    if (/^\t/.test(noComment)) throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const indent = noComment.length - noComment.trimStart().length;
    out.push({ indent, text: noComment.trimStart(), no: idx + 1 });
  });
  return out;
}

function splitFlow(inner: string, lineNo: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') {
        cur += inner[++i] ?? '';
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (quote) throw new YamlError('unterminated quote in flow collection', lineNo);
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function parseScalar(raw: string, lineNo = 0): unknown {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('unterminated double quote', lineNo);
    return JSON.parse(s);
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError('unterminated single quote', lineNo);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError('unterminated flow list', lineNo);
    return splitFlow(s.slice(1, -1), lineNo).map((p) => parseScalar(p, lineNo));
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError('unterminated flow map', lineNo);
    const obj: Record<string, unknown> = {};
    for (const part of splitFlow(s.slice(1, -1), lineNo)) {
      const kv = splitKey(part);
      if (!kv) throw new YamlError(`bad flow map entry "${part}"`, lineNo);
      obj[kv.key] = parseScalar(kv.rest, lineNo);
    }
    return obj;
  }
  return s;
}

// Returns {key, rest} if text is "key: value" / "key:" (key may be quoted).
function splitKey(text: string): { key: string; rest: string } | null {
  let m = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s+|$)(.*)$/.exec(text);
  if (m) return { key: JSON.parse(`"${m[1]}"`), rest: m[2] };
  m = /^'((?:[^']|'')*)'\s*:(?:\s+|$)(.*)$/.exec(text);
  if (m) return { key: m[1].replace(/''/g, "'"), rest: m[2] };
  m = /^([^\s"'\[\]{},#][^:#]*?)\s*:(?:\s+|$)(.*)$/.exec(text);
  if (m) return { key: m[1], rest: m[2] };
  return null;
}

export function parseYaml(src: string): unknown {
  const lines = tokenize(src);
  let pos = 0;

  function isListItem(l: Line): boolean {
    return l.text === '-' || l.text.startsWith('- ');
  }

  function parseBlock(indent: number): unknown {
    const first = lines[pos];
    if (!first) return null;
    if (isListItem(first)) return parseList(indent);
    return parseMap(indent);
  }

  function parseList(indent: number): unknown[] {
    const arr: unknown[] = [];
    while (pos < lines.length && lines[pos].indent === indent && isListItem(lines[pos])) {
      const line = lines[pos];
      const rest = line.text === '-' ? '' : line.text.slice(2);
      const restTrim = rest.trimStart();
      const offset = line.text.length - restTrim.length;
      if (!restTrim) {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) arr.push(parseBlock(lines[pos].indent));
        else arr.push(null);
      } else if (splitKey(restTrim) && !/^[\[{]/.test(restTrim)) {
        // "- key: value" starts a map whose keys sit at indent + offset
        lines[pos] = { indent: indent + offset, text: restTrim, no: line.no };
        arr.push(parseMap(indent + offset));
      } else if (isListItem({ indent: 0, text: restTrim, no: line.no })) {
        lines[pos] = { indent: indent + offset, text: restTrim, no: line.no };
        arr.push(parseList(indent + offset));
      } else {
        arr.push(parseScalar(restTrim, line.no));
        pos++;
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new YamlError('unexpected indentation', lines[pos].no);
    }
    return arr;
  }

  function parseMap(indent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      if (isListItem(line)) throw new YamlError('list item where a key was expected', line.no);
      const kv = splitKey(line.text);
      if (!kv) throw new YamlError(`expected "key: value", got "${line.text}"`, line.no);
      pos++;
      if (kv.rest.trim() === '' || kv.rest.trim() === '|' || kv.rest.trim() === '>') {
        if (kv.rest.trim() === '|' || kv.rest.trim() === '>') {
          throw new YamlError('block scalars (| or >) are not supported', line.no);
        }
        const next = lines[pos];
        if (next && next.indent > indent) obj[kv.key] = parseBlock(next.indent);
        else if (next && next.indent === indent && isListItem(next)) obj[kv.key] = parseList(indent);
        else obj[kv.key] = null;
      } else {
        obj[kv.key] = parseScalar(kv.rest, line.no);
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new YamlError('unexpected indentation', lines[pos].no);
    }
    return obj;
  }

  if (!lines.length) return null;
  const result = parseBlock(lines[0].indent);
  if (pos < lines.length) throw new YamlError('unexpected content', lines[pos].no);
  return result;
}

const PLAIN_SAFE = /^[A-Za-z0-9_./@][A-Za-z0-9_./@ +-]*$/;

export function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (PLAIN_SAFE.test(s) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) && !s.endsWith(' ')) return s;
  return JSON.stringify(s);
}

export function stringifyYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]\n`;
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return `${pad}[${value.map(yamlScalar).join(', ')}]\n`;
    }
    return value
      .map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const body = stringifyYaml(item, indent + 2);
          return `${pad}- ${body.slice(indent + 2)}`;
        }
        return `${pad}- ${yamlScalar(item)}\n`;
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return `${pad}{}\n`;
    return entries
      .map(([k, v]) => {
        const key = yamlScalar(k);
        if (v && typeof v === 'object') {
          if (Array.isArray(v) && (v.length === 0 || v.every((x) => x === null || typeof x !== 'object'))) {
            return `${pad}${key}: ${stringifyYaml(v, 0).trim()}\n`;
          }
          if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${key}: {}\n`;
          return `${pad}${key}:\n${stringifyYaml(v, indent + 2)}`;
        }
        return `${pad}${key}: ${yamlScalar(v)}\n`;
      })
      .join('');
  }
  return `${pad}${yamlScalar(value)}\n`;
}
