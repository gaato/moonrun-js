import { err, ok, type Result } from '../../ports/result.ts';
import {
  defaultOf,
  type FieldDef,
  invalidLength,
  invalidType,
  type Schema,
  type Struct,
  type Unexpected,
  unknownField,
  type Value,
} from './schema.ts';

/**
 * A TOML 1.0 reader plus serde-style schema checking, reproducing the `toml` crate's error
 * rendering (`TOML parse error at line L, column C` with a source excerpt) for the mistakes a
 * policy file can contain. Syntax messages cover the common cases; rarer ones use the closest
 * toml_edit wording.
 */

export interface Span {
  readonly start: number;
  readonly end: number;
}

export type TNode =
  | { readonly k: 'null'; readonly span: Span }
  | { readonly k: 'str'; readonly v: string; readonly span: Span }
  | { readonly k: 'int'; readonly text: string; readonly span: Span }
  | { readonly k: 'float'; readonly v: number; readonly span: Span }
  | { readonly k: 'bool'; readonly v: boolean; readonly span: Span }
  | { readonly k: 'datetime'; readonly span: Span }
  | { readonly k: 'array'; readonly items: TNode[]; span: Span; readonly tables: boolean }
  | TTable;

export interface TTable {
  readonly k: 'table';
  readonly entries: Map<string, { key: Span; value: TNode }>;
  /** How the table came to exist; decides which later definitions are duplicates. */
  kind: 'root' | 'header' | 'dotted' | 'implicit' | 'inline';
  span: Span;
}

class TomlSyntaxError {
  readonly message: string;
  readonly span: Span;
  constructor(message: string, span: Span) {
    this.message = message;
    this.span = span;
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class Parser {
  pos = 0;
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  fail(message: string, start: number, end = start + 1): never {
    throw new TomlSyntaxError(message, { start, end: Math.max(end, start + 1) });
  }

  peek(): string {
    return this.src[this.pos] ?? '';
  }

  skipBlank(): void {
    while (this.peek() === ' ' || this.peek() === '\t') {
      this.pos++;
    }
  }

  skipComment(): void {
    if (this.peek() === '#') {
      while (this.pos < this.src.length && this.peek() !== '\n') {
        if (this.peek() === '\r' && this.src[this.pos + 1] === '\n') {
          break;
        }
        this.pos++;
      }
    }
  }

  atNewline(): boolean {
    return this.peek() === '\n' || (this.peek() === '\r' && this.src[this.pos + 1] === '\n');
  }

  parseDocument(): TTable {
    const root: TTable = {
      k: 'table',
      entries: new Map(),
      kind: 'root',
      span: { start: 0, end: 0 },
    };
    let current = root;
    for (;;) {
      this.skipBlank();
      this.skipComment();
      if (this.pos >= this.src.length) {
        return root;
      }
      if (this.atNewline()) {
        this.pos += this.peek() === '\r' ? 2 : 1;
        continue;
      }
      const c = this.peek();
      if (c === '[') {
        current = this.parseHeader(root);
      } else {
        this.parseKeyValue(current);
      }
      this.skipBlank();
      this.skipComment();
      if (this.pos < this.src.length && !this.atNewline()) {
        this.fail('unexpected key or value, expected newline, `#`', this.pos);
      }
    }
  }

  parseKey(): { name: string; span: Span }[] {
    const keys: { name: string; span: Span }[] = [];
    for (;;) {
      this.skipBlank();
      const start = this.pos;
      const c = this.peek();
      let name: string;
      if (c === '"') {
        name = this.parseBasicString(false);
      } else if (c === "'") {
        name = this.parseLiteralString(false);
      } else {
        while (BARE_KEY.test(this.peek())) {
          this.pos++;
        }
        name = this.src.slice(start, this.pos);
        if (name === '') {
          this.fail('unquoted keys cannot be empty, expected letters, numbers, `-`, `_`', start);
        }
      }
      keys.push({ name, span: { start, end: this.pos } });
      this.skipBlank();
      if (this.peek() === '.') {
        this.pos++;
        continue;
      }
      return keys;
    }
  }

  parseHeader(root: TTable): TTable {
    const open = this.pos;
    const array = this.src[this.pos + 1] === '[';
    this.pos += array ? 2 : 1;
    const keys = this.parseKey();
    const close = array ? ']]' : ']';
    if (!this.src.startsWith(close, this.pos)) {
      this.fail('unclosed table, expected `]`', this.pos);
    }
    this.pos += close.length;
    const headerSpan = { start: open, end: this.pos };
    let table = root;
    for (const [i, key] of keys.entries()) {
      const last = i === keys.length - 1;
      const existing = table.entries.get(key.name);
      if (!last) {
        if (existing === undefined) {
          const t: TTable = { k: 'table', entries: new Map(), kind: 'implicit', span: key.span };
          table.entries.set(key.name, { key: key.span, value: t });
          table = t;
        } else if (existing.value.k === 'table' && existing.value.kind !== 'inline') {
          table = existing.value;
        } else if (existing.value.k === 'array' && existing.value.tables) {
          const lastTable = existing.value.items[existing.value.items.length - 1];
          if (lastTable?.k !== 'table') {
            this.fail('duplicate key', key.span.start, key.span.end);
          }
          table = lastTable;
        } else {
          this.fail('duplicate key', key.span.start, key.span.end);
        }
        continue;
      }
      if (array) {
        if (existing === undefined) {
          const t: TTable = { k: 'table', entries: new Map(), kind: 'header', span: headerSpan };
          table.entries.set(key.name, {
            key: key.span,
            value: { k: 'array', items: [t], span: headerSpan, tables: true },
          });
          return t;
        }
        if (existing.value.k === 'array' && existing.value.tables) {
          const t: TTable = { k: 'table', entries: new Map(), kind: 'header', span: headerSpan };
          existing.value.items.push(t);
          return t;
        }
        this.fail('duplicate key', key.span.start, key.span.end);
      }
      if (existing === undefined) {
        const t: TTable = { k: 'table', entries: new Map(), kind: 'header', span: headerSpan };
        table.entries.set(key.name, { key: key.span, value: t });
        return t;
      }
      if (existing.value.k === 'table' && existing.value.kind === 'implicit') {
        existing.value.kind = 'header';
        existing.value.span = headerSpan;
        return existing.value;
      }
      this.fail('duplicate key', key.span.start, key.span.end);
    }
    return table;
  }

  parseKeyValue(table: TTable): void {
    const keys = this.parseKey();
    this.skipBlank();
    if (this.peek() !== '=') {
      this.fail('key with no value, expected `=`', this.pos);
    }
    this.pos++;
    this.skipBlank();
    let target = table;
    for (const key of keys.slice(0, -1)) {
      const existing = target.entries.get(key.name);
      if (existing === undefined) {
        const t: TTable = { k: 'table', entries: new Map(), kind: 'dotted', span: key.span };
        target.entries.set(key.name, { key: key.span, value: t });
        target = t;
      } else if (existing.value.k === 'table' && existing.value.kind === 'dotted') {
        target = existing.value;
      } else {
        this.fail('duplicate key', key.span.start, key.span.end);
      }
    }
    const lastKey = keys[keys.length - 1];
    if (lastKey === undefined) {
      this.fail('unquoted keys cannot be empty, expected letters, numbers, `-`, `_`', this.pos);
    }
    if (target.entries.has(lastKey.name)) {
      this.fail('duplicate key', lastKey.span.start, lastKey.span.end);
    }
    const value = this.parseValue();
    target.entries.set(lastKey.name, { key: lastKey.span, value });
  }

  parseValue(): TNode {
    const start = this.pos;
    const c = this.peek();
    if (c === '"') {
      const triple = this.src.startsWith('"""', start);
      const v = this.parseBasicString(triple);
      return { k: 'str', v, span: { start, end: this.pos } };
    }
    if (c === "'") {
      const triple = this.src.startsWith("'''", start);
      const v = this.parseLiteralString(triple);
      return { k: 'str', v, span: { start, end: this.pos } };
    }
    if (c === '[') {
      return this.parseArray();
    }
    if (c === '{') {
      return this.parseInlineTable();
    }
    return this.parseScalar();
  }

  parseScalar(): TNode {
    const start = this.pos;
    const rest = this.src.slice(start);
    const dt =
      /^(\d{4}-\d\d-\d\d([Tt ]\d\d:\d\d(:\d\d(\.\d+)?)?([Zz]|[+-]\d\d:\d\d)?)?|\d\d:\d\d(:\d\d(\.\d+)?)?)(?![\w.])/.exec(
        rest,
      );
    if (dt !== null) {
      this.pos += dt[0].length;
      return { k: 'datetime', span: { start, end: this.pos } };
    }
    let end = start;
    while (end < this.src.length && /[A-Za-z0-9_+\-.]/.test(this.src[end] ?? '')) {
      end++;
    }
    const token = this.src.slice(start, end);
    if (token === 'true' || token === 'false') {
      this.pos = end;
      return { k: 'bool', v: token === 'true', span: { start, end } };
    }
    if (/^[tf][a-z]*$/.test(token) && (token.startsWith('t') || token.startsWith('f'))) {
      this.fail(
        `invalid boolean, expected \`${token.startsWith('t') ? 'true' : 'false'}\``,
        start,
        end,
      );
    }
    const sign = token.startsWith('+') || token.startsWith('-') ? token.slice(0, 1) : '';
    const body = token.slice(sign.length);
    if (body === 'inf' || body === 'nan') {
      this.pos = end;
      return {
        k: 'float',
        v: body === 'nan' ? Number.NaN : sign === '-' ? -Infinity : Infinity,
        span: { start, end },
      };
    }
    const radix = /^0([xob])([0-9a-fA-F_]+)$/.exec(body);
    if (radix !== null && sign === '') {
      const digits = (radix[2] ?? '').replaceAll('_', '');
      const base = radix[1] === 'x' ? 16 : radix[1] === 'o' ? 8 : 2;
      if (!new RegExp(`^[${'0123456789abcdef'.slice(0, base)}]+$`, 'i').test(digits)) {
        this.fail('invalid number', start, end);
      }
      this.pos = end;
      return this.intNode(BigInt(`0${radix[1]}${digits}`), start, end);
    }
    if (/^\d[\d_]*$/.test(body)) {
      if (/__|_$/.test(body)) {
        this.fail('`_` may only go between digits', start + sign.length + body.indexOf('_'));
      }
      if (body.length > 1 && body.startsWith('0')) {
        this.fail('unexpected leading zero, expected nothing', start);
      }
      this.pos = end;
      // `1 2`: a number followed by more value text reads as an unquoted string.
      const junk = /^[ \t]+[^\s#][^\n#]*/.exec(this.src.slice(end));
      if (junk !== null && /^[ \t]+\d/.test(junk[0])) {
        this.fail(
          'string values must be quoted, expected literal string',
          start,
          end + junk[0].trimEnd().length,
        );
      }
      const big = BigInt(sign + body.replaceAll('_', ''));
      return this.intNode(big, start, end);
    }
    const float = /^(\d[\d_]*)(\.(\d[\d_]*)?)?([eE][+-]?(\d[\d_]*)?)?$/.exec(body);
    if (float !== null && (float[2] !== undefined || float[4] !== undefined)) {
      if (float[2] === '.') {
        this.fail('invalid fraction, expected digits', end);
      }
      if (float[4] !== undefined && float[5] === undefined) {
        this.fail('invalid exponent, expected digits', end);
      }
      this.pos = end;
      return { k: 'float', v: Number(sign + body.replaceAll('_', '')), span: { start, end } };
    }
    if (body.startsWith('.')) {
      this.fail('invalid mantissa, expected digits', start);
    }
    // Anything else is an unquoted string, which TOML forbids.
    let lineEnd = start;
    while (lineEnd < this.src.length && !'\n#'.includes(this.src[lineEnd] ?? '\n')) {
      lineEnd++;
    }
    const text = this.src.slice(start, lineEnd).trimEnd();
    this.fail(
      'string values must be quoted, expected literal string',
      start,
      start + Math.max(text.length, 1),
    );
  }

  intNode(value: bigint, start: number, end: number): TNode {
    if (value > 0x7fffffffffffffffn || value < -0x8000000000000000n) {
      this.fail('number too large to fit in target type', start, end);
    }
    return { k: 'int', text: value.toString(), span: { start, end } };
  }

  parseArray(): TNode {
    const start = this.pos;
    this.pos++;
    const items: TNode[] = [];
    let expectValue = true;
    for (;;) {
      this.skipWsNewlinesComments();
      const c = this.peek();
      if (c === '') {
        this.fail('unclosed array, expected `]`', this.pos);
      }
      if (c === ']') {
        this.pos++;
        return { k: 'array', items, span: { start, end: this.pos }, tables: false };
      }
      if (c === ',') {
        if (expectValue) {
          this.fail('extra comma in array, expected value', this.pos);
        }
        this.pos++;
        expectValue = true;
        continue;
      }
      if (!expectValue) {
        this.fail('missing comma between array elements, expected `,`', this.pos);
      }
      items.push(this.parseValue());
      expectValue = false;
    }
  }

  skipWsNewlinesComments(): void {
    for (;;) {
      this.skipBlank();
      this.skipComment();
      if (this.atNewline()) {
        this.pos += this.peek() === '\r' ? 2 : 1;
      } else {
        return;
      }
    }
  }

  parseInlineTable(): TNode {
    const start = this.pos;
    this.pos++;
    const table: TTable = {
      k: 'table',
      entries: new Map(),
      kind: 'inline',
      span: { start, end: start },
    };
    this.skipBlank();
    if (this.peek() === '}') {
      this.pos++;
      table.span = { start, end: this.pos };
      return table;
    }
    for (;;) {
      this.skipBlank();
      if (this.atNewline() || this.peek() === '') {
        this.fail('newlines are unsupported in inline tables, expected nothing', this.pos);
      }
      this.parseKeyValue(table);
      this.skipBlank();
      const c = this.peek();
      if (c === ',') {
        this.pos++;
      } else if (c === '}') {
        this.pos++;
        table.span = { start, end: this.pos };
        return table;
      } else {
        this.fail('newlines are unsupported in inline tables, expected nothing', this.pos);
      }
    }
  }

  parseLiteralString(triple: boolean): string {
    if (triple) {
      this.pos += 3;
      if (this.src[this.pos] === '\n') {
        this.pos++;
      } else if (this.src.startsWith('\r\n', this.pos)) {
        this.pos += 2;
      }
      const end = this.src.indexOf("'''", this.pos);
      if (end < 0) {
        this.fail("invalid multi-line literal string, expected `'`", this.src.length);
      }
      let close = end;
      while (this.src[close + 3] === "'" && close - end < 2) {
        close++;
      }
      const v = this.src.slice(this.pos, close);
      this.pos = close + 3;
      return v;
    }
    this.pos++;
    const end = this.findLineEnd(this.pos, "'");
    if (this.src[end] !== "'") {
      this.fail("invalid literal string, expected `'`", end);
    }
    const v = this.src.slice(this.pos, end);
    this.pos = end + 1;
    return v;
  }

  findLineEnd(from: number, quote: string): number {
    let i = from;
    while (i < this.src.length && this.src[i] !== quote && this.src[i] !== '\n') {
      i++;
    }
    return i;
  }

  parseBasicString(triple: boolean): string {
    this.pos += triple ? 3 : 1;
    if (triple) {
      if (this.src[this.pos] === '\n') {
        this.pos++;
      } else if (this.src.startsWith('\r\n', this.pos)) {
        this.pos += 2;
      }
    }
    let out = '';
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined || (!triple && c === '\n')) {
        this.fail(
          triple
            ? 'invalid multi-line basic string, expected `"`'
            : 'invalid basic string, expected `"`',
          this.pos,
        );
      }
      if (triple ? this.src.startsWith('"""', this.pos) : c === '"') {
        if (triple) {
          let extra = 0;
          while (this.src[this.pos + 3 + extra] === '"' && extra < 2) {
            extra++;
          }
          out += '"'.repeat(extra);
          this.pos += 3 + extra;
        } else {
          this.pos++;
        }
        return out;
      }
      if (c === '\\') {
        out += this.parseEscape(triple);
        continue;
      }
      const code = c.charCodeAt(0);
      if ((code < 0x20 && c !== '\t' && !(triple && (c === '\n' || c === '\r'))) || code === 0x7f) {
        this.fail(
          'invalid basic string, expected non-double-quote visible characters, `\\`',
          this.pos,
        );
      }
      out += c;
      this.pos++;
    }
  }

  parseEscape(triple: boolean): string {
    this.pos++;
    const e = this.src[this.pos];
    const simple: Readonly<Record<string, string>> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };
    if (e !== undefined && e in simple) {
      this.pos++;
      return simple[e] ?? '';
    }
    if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const digits = this.src.slice(this.pos + 1, this.pos + 1 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(digits)) {
        const good = /^[0-9a-fA-F]*/.exec(digits)?.[0].length ?? 0;
        this.fail(
          'too few unicode value digits, expected unicode hexadecimal value',
          this.pos + 1 + good,
        );
      }
      const cp = Number.parseInt(digits, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        this.fail(
          'invalid unicode value, expected a unicode scalar value',
          this.pos + 1,
          this.pos + 1 + len,
        );
      }
      this.pos += 1 + len;
      return String.fromCodePoint(cp);
    }
    if (triple && (e === ' ' || e === '\t' || e === '\n' || e === '\r')) {
      let i = this.pos;
      while (this.src[i] === ' ' || this.src[i] === '\t') {
        i++;
      }
      if (this.src[i] === '\n' || this.src.startsWith('\r\n', i)) {
        while (/[ \t\r\n]/.test(this.src[i] ?? '')) {
          i++;
        }
        this.pos = i;
        return '';
      }
    }
    this.fail('missing escaped value, expected `b`, `f`, `n`, `r`, `\\`, `"`, `u`, `U`', this.pos);
  }
}

// --- Rendering ------------------------------------------------------------------------------

function render(src: string, span: Span, message: string): string {
  const cps = (s: string): number => Array.from(s).length;
  const start = Math.min(span.start, src.length);
  // An error at end of input is reported on the last line, counting its newline as a column.
  const atEnd = start === src.length && src.endsWith('\n');
  const lineStart = src.lastIndexOf('\n', atEnd ? start - 2 : start - 1) + 1;
  let lineEnd = src.indexOf('\n', start);
  if (lineEnd < 0) {
    lineEnd = src.length;
  }
  const lineNo = src.slice(0, lineStart).split('\n').length;
  const text = src.slice(lineStart, atEnd ? start - 1 : lineEnd).replace(/\r$/, '');
  const column = cps(src.slice(lineStart, start)) + 1;
  const width = Math.max(1, cps(src.slice(start, Math.min(span.end, lineStart + text.length))));
  const pad = ' '.repeat(String(lineNo).length + 1);
  return [
    `TOML parse error at line ${lineNo}, column ${column}`,
    `${pad}|`,
    `${lineNo} | ${text}`,
    `${pad}| ${' '.repeat(column - 1)}${'^'.repeat(width)}`,
    message,
    '',
  ].join('\n');
}

// --- Schema ---------------------------------------------------------------------------------

export class SchemaError {
  readonly message: string;
  readonly span: Span;
  constructor(message: string, span: Span) {
    this.message = message;
    this.span = span;
  }
}

function unexpected(node: TNode): Unexpected {
  switch (node.k) {
    case 'str':
      return { k: 'str', v: node.v };
    case 'int':
      return { k: 'int', text: node.text };
    case 'float':
      return { k: 'float', v: node.v };
    case 'bool':
      return { k: 'bool', v: node.v };
    case 'null':
      return { k: 'unit' };
    case 'datetime':
    case 'table':
      return { k: 'map' };
    case 'array':
      return { k: 'seq' };
  }
}

export function deserializeTree(node: TNode, schema: Schema): Value {
  const bad = (): SchemaError =>
    new SchemaError(invalidType(unexpected(node), schema, false), node.span);
  switch (schema.k) {
    case 'string':
    case 'path':
      if (node.k !== 'str') {
        throw bad();
      }
      return node.v;
    case 'bool':
      if (node.k !== 'bool') {
        throw bad();
      }
      return node.v;
    case 'seq':
      if (node.k !== 'array') {
        throw bad();
      }
      return node.items.map((item) => deserializeTree(item, schema.item));
    case 'stringMap': {
      if (node.k !== 'table') {
        throw bad();
      }
      const map = new Map<string, string>();
      for (const [key, entry] of node.entries) {
        map.set(key, deserializeTree(entry.value, { k: 'string' }) as string);
      }
      return map;
    }
    case 'struct': {
      if (node.k === 'array') {
        const out: Record<string, Value> = {};
        for (const [i, f] of schema.fields.entries()) {
          const item = node.items[i];
          if (item !== undefined) {
            out[f.name] = deserializeTree(item, f.schema);
          } else if (f.mode === 'default') {
            out[f.name] = defaultOf(f.schema);
          } else {
            throw new SchemaError(invalidLength(i, schema), node.span);
          }
        }
        return out;
      }
      if (node.k !== 'table') {
        throw bad();
      }
      const out: Record<string, Value> = {};
      for (const [key, entry] of node.entries) {
        const f: FieldDef | undefined = schema.fields.find((x) => x.name === key);
        if (f === undefined) {
          throw new SchemaError(unknownField(key, schema.fields), entry.key);
        }
        out[key] =
          f.mode === 'option' && entry.value.k === 'null'
            ? null
            : deserializeTree(entry.value, f.schema);
      }
      for (const f of schema.fields) {
        if (!(f.name in out)) {
          if (f.mode === 'required') {
            throw new SchemaError(`missing field \`${f.name}\``, node.span);
          }
          out[f.name] = f.mode === 'option' ? null : defaultOf(f.schema);
        }
      }
      return out as Struct;
    }
  }
}

/** `toml::from_str::<PolicyConfig>`: the value, or the toml crate's multi-line error Display. */
export function parseTomlWithSchema(text: string, schema: Schema): Result<Value, string> {
  try {
    const root = new Parser(text).parseDocument();
    return ok(deserializeTree(root, schema));
  } catch (e) {
    if (e instanceof TomlSyntaxError || e instanceof SchemaError) {
      return err(render(text, e.span, e.message));
    }
    throw e;
  }
}
