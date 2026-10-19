import { err, ok, type Result } from '../../ports/result.ts';
import { rustTrimStart } from './rust-fmt.ts';
import type { Schema, Value } from './schema.ts';
import { deserializeTree, SchemaError, type Span, type TNode, type TTable } from './toml.ts';

/**
 * `.mbtx` policy front matter: extraction is a port of moonutil's `extract_mbtx_front_matter`;
 * the YAML body is read with a deliberately small subset (block mappings and sequences, flow
 * collections, plain and quoted scalars). Anchors, tags, multi-line scalars and documents are
 * not supported and fail with an error.
 */

function commentContent(line: string): string | undefined {
  const comment = rustTrimStart(line);
  if (!comment.startsWith('//')) {
    return undefined;
  }
  const rest = comment.slice(2);
  if (rest !== '' && !rest.startsWith(' ') && !rest.startsWith('\t')) {
    return undefined;
  }
  return rest.startsWith(' ') ? rest.slice(1) : rest;
}

/** The YAML text of a leading `// policy:` block, or `undefined` when the file has none. */
export function extractMbtxFrontMatter(content: string): string | undefined {
  const text = content.startsWith('﻿') ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') {
    i++;
  }
  const first = commentContent(lines[i] ?? '');
  if (first === undefined || !first.trim().startsWith('policy:')) {
    return undefined;
  }
  let yaml = `${first}\n`;
  for (const line of lines.slice(i + 1)) {
    const c = commentContent(line);
    if (c === undefined || (c !== '' && !c.startsWith(' ') && !c.startsWith('\t'))) {
      break;
    }
    yaml += `${c}\n`;
  }
  return yaml;
}

class YamlError {
  readonly message: string;
  readonly offset: number;
  constructor(message: string, offset: number) {
    this.message = message;
    this.offset = offset;
  }
}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly offset: number;
}

function stripComment(text: string): string {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (quote !== '') {
      if (c === quote) {
        quote = '';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function scalar(raw: string, span: Span): TNode {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') {
    return { k: 'null', span };
  }
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return { k: 'str', v: JSON.parse(t) as string, span };
    } catch {
      throw new YamlError(
        'found unknown escape character while parsing a quoted scalar',
        span.start,
      );
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return { k: 'str', v: t.slice(1, -1).replaceAll("''", "'"), span };
  }
  if (t === 'true' || t === 'false') {
    return { k: 'bool', v: t === 'true', span };
  }
  if (/^[-+]?\d+$/.test(t)) {
    return { k: 'int', text: String(BigInt(t)), span };
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) {
    return { k: 'float', v: Number(t), span };
  }
  if (/^[&*!|>]/.test(t)) {
    throw new YamlError('unsupported YAML syntax', span.start);
  }
  return { k: 'str', v: t, span };
}

/** Flow collections: `[a, b]` and `{k: v}`. */
function parseFlow(text: string, base: number): TNode {
  let i = 0;
  const skip = (): void => {
    while (/\s/.test(text[i] ?? '')) {
      i++;
    }
  };
  const value = (): TNode => {
    skip();
    const start = i;
    const c = text[i];
    if (c === '[') {
      i++;
      const items: TNode[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') {
          i++;
          return { k: 'array', items, span: { start: base + start, end: base + i }, tables: false };
        }
        items.push(value());
        skip();
        if (text[i] === ',') {
          i++;
        } else if (text[i] !== ']') {
          throw new YamlError("did not find expected ',' or ']'", base + i);
        }
      }
    }
    if (c === '{') {
      i++;
      const table: TTable = {
        k: 'table',
        entries: new Map(),
        kind: 'inline',
        span: { start: base + start, end: base + start },
      };
      for (;;) {
        skip();
        if (text[i] === '}') {
          i++;
          table.span = { start: base + start, end: base + i };
          return table;
        }
        const ks = i;
        while (i < text.length && !':,}'.includes(text[i] ?? '')) {
          i++;
        }
        const key = scalar(text.slice(ks, i), { start: base + ks, end: base + i });
        if (text[i] !== ':') {
          throw new YamlError("did not find expected ',' or '}'", base + i);
        }
        i++;
        const v = value();
        table.entries.set(key.k === 'str' ? key.v : text.slice(ks, i).trim(), {
          key: { start: base + ks, end: base + ks + 1 },
          value: v,
        });
        skip();
        if (text[i] === ',') {
          i++;
        }
      }
    }
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) {
        throw new YamlError('unexpected end of stream while scanning a quoted scalar', base + i);
      }
      i = close + 1;
      return scalar(text.slice(start, i), { start: base + start, end: base + i });
    }
    while (i < text.length && !',]}'.includes(text[i] ?? '')) {
      i++;
    }
    return scalar(text.slice(start, i), { start: base + start, end: base + i });
  };
  const node = value();
  skip();
  if (i < text.length) {
    throw new YamlError('did not find expected <document start>', base + i);
  }
  return node;
}

function parseBlock(lines: Line[], pos: { i: number }, indent: number): TNode {
  const line = lines[pos.i];
  if (line === undefined) {
    return { k: 'null', span: { start: 0, end: 0 } };
  }
  if (line.text.startsWith('- ') || line.text === '-') {
    const items: TNode[] = [];
    const start = line.offset;
    while (pos.i < lines.length) {
      const l = lines[pos.i];
      if (l === undefined || l.indent !== indent || !(l.text.startsWith('- ') || l.text === '-')) {
        break;
      }
      const rest = l.text.slice(1).trimStart();
      const restOffset = l.offset + (l.text.length - rest.length);
      if (rest === '') {
        pos.i++;
        const next = lines[pos.i];
        items.push(
          next !== undefined && next.indent > indent
            ? parseBlock(lines, pos, next.indent)
            : { k: 'null', span: { start: l.offset, end: l.offset + 1 } },
        );
      } else if (/^[^"'[{][^:]*:(\s|$)/.test(rest) || /^["'][^"']*["']:(\s|$)/.test(rest)) {
        // A mapping that starts on the dash line: re-indent it to the key column.
        const keyIndent = indent + (l.text.length - rest.length);
        lines[pos.i] = { indent: keyIndent, text: rest, offset: restOffset };
        items.push(parseBlock(lines, pos, keyIndent));
      } else {
        pos.i++;
        items.push(parseValueText(rest, restOffset));
      }
    }
    return { k: 'array', items, span: { start, end: start + 1 }, tables: false };
  }
  const table: TTable = {
    k: 'table',
    entries: new Map(),
    kind: 'inline',
    span: { start: line.offset, end: line.offset + 1 },
  };
  while (pos.i < lines.length) {
    const l = lines[pos.i];
    if (l === undefined || l.indent < indent) {
      break;
    }
    if (l.indent > indent) {
      throw new YamlError('did not find expected key', l.offset);
    }
    const m = /^("[^"]*"|'[^']*'|[^:#]+?)\s*:(?:\s+(.*))?$/.exec(l.text);
    if (m === null) {
      throw new YamlError('did not find expected key', l.offset);
    }
    const keyNode = scalar(m[1] ?? '', { start: l.offset, end: l.offset + (m[1] ?? '').length });
    const key = keyNode.k === 'str' ? keyNode.v : (m[1] ?? '');
    if (table.entries.has(key)) {
      throw new YamlError(`duplicate entry with key "${key}"`, l.offset);
    }
    const rest = (m[2] ?? '').trim();
    const keySpan = { start: l.offset, end: l.offset + (m[1] ?? '').length };
    pos.i++;
    let value: TNode;
    if (rest === '') {
      const next = lines[pos.i];
      if (
        next !== undefined &&
        (next.indent > indent || (next.indent === indent && next.text.startsWith('-')))
      ) {
        value = parseBlock(lines, pos, next.indent);
      } else {
        value = { k: 'null', span: keySpan };
      }
    } else {
      value = parseValueText(rest, l.offset + l.text.lastIndexOf(rest));
    }
    table.entries.set(key, { key: keySpan, value });
  }
  return table;
}

function parseValueText(text: string, offset: number): TNode {
  return text.startsWith('[') || text.startsWith('{')
    ? parseFlow(text, offset)
    : scalar(text, { start: offset, end: offset + text.length });
}

function lineCol(src: string, offset: number): [number, number] {
  const before = src.slice(0, offset);
  const line = before.split('\n').length;
  return [line, offset - (before.lastIndexOf('\n') + 1) + 1];
}

/** Reads the `policy:` value of an `// policy:` front matter block. */
export function parseYamlPolicy(yaml: string, schema: Schema): Result<Value, string> {
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of yaml.split('\n')) {
    const text = stripComment(raw).trimEnd();
    if (text.trim() !== '') {
      lines.push({ indent: text.length - text.trimStart().length, text: text.trimStart(), offset });
    }
    offset += raw.length + 1;
  }
  try {
    const pos = { i: 0 };
    const root = parseBlock(lines, pos, lines[0]?.indent ?? 0);
    if (pos.i < lines.length) {
      throw new YamlError('did not find expected key', lines[pos.i]?.offset ?? 0);
    }
    const policy = root.k === 'table' ? root.entries.get('policy') : undefined;
    if (policy === undefined) {
      return err('missing field `policy`');
    }
    return ok(deserializeTree(policy.value, schema));
  } catch (e) {
    if (e instanceof YamlError || e instanceof SchemaError) {
      const at = e instanceof YamlError ? e.offset : e.span.start;
      const [line, col] = lineCol(yaml, at);
      return err(`${e.message} at line ${line} column ${col}`);
    }
    throw e;
  }
}
