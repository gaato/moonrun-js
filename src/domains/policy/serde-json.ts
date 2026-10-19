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
 * A streaming deserializer that mirrors `serde_json::from_str` + serde derive for the policy
 * schema, including where each error is positioned (`at line L column C`, columns in bytes).
 * Validation happens while reading, so (like serde) a type error wins over a later syntax error.
 */

class JsonError {
  line = 0;
  column = 0;
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
  get positioned(): boolean {
    return this.line !== 0;
  }
  toString(): string {
    return this.positioned
      ? `${this.message} at line ${this.line} column ${this.column}`
      : this.message;
  }
}

const MSG = {
  eofList: 'EOF while parsing a list',
  eofObject: 'EOF while parsing an object',
  eofString: 'EOF while parsing a string',
  eofValue: 'EOF while parsing a value',
  colon: 'expected `:`',
  listEnd: 'expected `,` or `]`',
  objectEnd: 'expected `,` or `}`',
  ident: 'expected ident',
  value: 'expected value',
  escape: 'invalid escape',
  number: 'invalid number',
  range: 'number out of range',
  key: 'key must be a string',
  leadingSurrogate: 'lone leading surrogate in hex escape',
  trailingComma: 'trailing comma',
  trailing: 'trailing characters',
  hexEnd: 'unexpected end of hex escape',
  control: 'control character (\\u0000-\\u001F) found while parsing a string',
} as const;

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

class Reader {
  readonly bytes: Uint8Array;
  index = 0;
  constructor(text: string) {
    this.bytes = enc.encode(text);
  }

  /** serde_json `position_of_index`: bytes consumed, newline resets the column. */
  private posAt(index: number): [number, number] {
    let line = 1;
    let column = 0;
    for (let i = 0; i < index && i < this.bytes.length; i++) {
      if (this.bytes[i] === 0x0a) {
        line++;
        column = 0;
      } else {
        column++;
      }
    }
    if (index > this.bytes.length) {
      column += index - this.bytes.length;
    }
    return [line, column];
  }

  /** `self.error(code)`: at the current (consumed) position. */
  error(message: string): JsonError {
    return this.fix(new JsonError(message));
  }

  /** `self.peek_error(code)`: includes the peeked byte. */
  peekError(message: string): JsonError {
    const e = new JsonError(message);
    [e.line, e.column] = this.posAt(Math.min(this.index + 1, this.bytes.length));
    return e;
  }

  fix(e: JsonError): JsonError {
    if (!e.positioned) {
      [e.line, e.column] = this.posAt(this.index);
    }
    return e;
  }

  peek(): number | undefined {
    return this.bytes[this.index];
  }

  eat(): void {
    this.index++;
  }

  next(): number | undefined {
    const b = this.bytes[this.index];
    if (b !== undefined) {
      this.index++;
    }
    return b;
  }

  /** `parse_whitespace`: skips JSON whitespace, returns the next byte. */
  ws(): number | undefined {
    while (this.index < this.bytes.length && SPACE.has(this.bytes[this.index] ?? 0)) {
      this.index++;
    }
    return this.peek();
  }

  ident(rest: string): void {
    for (const ch of rest) {
      const b = this.next();
      if (b === undefined) {
        throw this.error(MSG.eofValue);
      }
      if (b !== ch.charCodeAt(0)) {
        throw this.error(MSG.ident);
      }
    }
  }

  private hex4(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.next();
      if (b === undefined) {
        throw this.error(MSG.eofString);
      }
      const d = hexVal(b);
      if (d === undefined) {
        throw this.error(MSG.escape);
      }
      n = n * 16 + d;
    }
    return n;
  }

  /** `parse_str` after the opening quote. */
  str(): string {
    const out: number[] = [];
    let text = '';
    const flush = (): void => {
      if (out.length > 0) {
        text += dec.decode(Uint8Array.from(out));
        out.length = 0;
      }
    };
    for (;;) {
      const b = this.next();
      if (b === undefined) {
        throw this.error(MSG.eofString);
      }
      if (b === 0x22) {
        flush();
        return text;
      }
      if (b === 0x5c) {
        flush();
        const e = this.next();
        if (e === undefined) {
          throw this.error(MSG.eofString);
        }
        const simple: Readonly<Record<number, string>> = {
          34: '"',
          92: '\\',
          47: '/',
          98: '\b',
          102: '\f',
          110: '\n',
          114: '\r',
          116: '\t',
        };
        const s = simple[e];
        if (s !== undefined) {
          text += s;
        } else if (e === 0x75) {
          const n = this.hex4();
          if (n >= 0xdc00 && n <= 0xdfff) {
            throw this.error(MSG.leadingSurrogate);
          }
          if (n >= 0xd800 && n <= 0xdbff) {
            if (this.next() !== 0x5c) {
              throw this.error(MSG.hexEnd);
            }
            if (this.next() !== 0x75) {
              throw this.error(MSG.hexEnd);
            }
            const n2 = this.hex4();
            if (n2 < 0xdc00 || n2 > 0xdfff) {
              throw this.error(MSG.leadingSurrogate);
            }
            text += String.fromCodePoint(0x10000 + ((n - 0xd800) << 10) + (n2 - 0xdc00));
          } else {
            text += String.fromCharCode(n);
          }
        } else {
          throw this.error(MSG.escape);
        }
      } else if (b < 0x20) {
        throw this.error(MSG.control);
      } else {
        out.push(b);
      }
    }
  }

  /** `parse_any_number`; the sign has already been consumed. */
  number(positive: boolean): Unexpected {
    const first = this.next();
    if (first === undefined) {
      throw this.error(MSG.eofValue);
    }
    let digits: string;
    if (first === 0x30) {
      const p = this.peek();
      if (p !== undefined && p >= 0x30 && p <= 0x39) {
        throw this.peekError(MSG.number);
      }
      digits = '0';
    } else if (first >= 0x31 && first <= 0x39) {
      digits = String.fromCharCode(first);
      for (;;) {
        const p = this.peek();
        if (p === undefined || p < 0x30 || p > 0x39) {
          break;
        }
        digits += String.fromCharCode(p);
        this.eat();
      }
    } else {
      throw this.error(MSG.number);
    }
    let text = digits;
    let isFloat = false;
    if (this.peek() === 0x2e) {
      this.eat();
      isFloat = true;
      let frac = '';
      for (;;) {
        const p = this.peek();
        if (p === undefined || p < 0x30 || p > 0x39) {
          break;
        }
        frac += String.fromCharCode(p);
        this.eat();
      }
      if (frac === '') {
        throw this.peek() === undefined ? this.error(MSG.eofValue) : this.peekError(MSG.number);
      }
      text += `.${frac}`;
    }
    const e = this.peek();
    if (e === 0x65 || e === 0x45) {
      this.eat();
      isFloat = true;
      let exp = 'e';
      let c = this.next();
      if (c === undefined) {
        throw this.error(MSG.eofValue);
      }
      if (c === 0x2b || c === 0x2d) {
        exp += String.fromCharCode(c);
        c = this.next();
        if (c === undefined) {
          throw this.error(MSG.eofValue);
        }
      }
      if (c < 0x30 || c > 0x39) {
        throw this.error(MSG.number);
      }
      exp += String.fromCharCode(c);
      for (;;) {
        const p = this.peek();
        if (p === undefined || p < 0x30 || p > 0x39) {
          break;
        }
        exp += String.fromCharCode(p);
        this.eat();
      }
      text += exp;
    }
    const sign = positive ? '' : '-';
    if (!isFloat) {
      const big = BigInt(digits);
      if (positive && big <= 0xffffffffffffffffn) {
        return { k: 'int', text: digits };
      }
      if (!positive && big !== 0n && big <= 1n << 63n) {
        return { k: 'int', text: `-${digits}` };
      }
    }
    const value = Number(`${sign}${text}`);
    if (!Number.isFinite(value)) {
      throw this.error(MSG.range);
    }
    return { k: 'float', v: value };
  }

  /** `peek_invalid_type` (without the position fix): consumes scalars, leaves brackets. */
  invalidTypeOf(schema: Schema): JsonError {
    const p = this.peek();
    let u: Unexpected;
    switch (p) {
      case 0x6e:
        this.eat();
        this.ident('ull');
        u = { k: 'unit' };
        break;
      case 0x74:
        this.eat();
        this.ident('rue');
        u = { k: 'bool', v: true };
        break;
      case 0x66:
        this.eat();
        this.ident('alse');
        u = { k: 'bool', v: false };
        break;
      case 0x2d:
        this.eat();
        u = this.number(false);
        break;
      case 0x22:
        this.eat();
        u = { k: 'str', v: this.str() };
        break;
      case 0x5b:
        u = { k: 'seq' };
        break;
      case 0x7b:
        u = { k: 'map' };
        break;
      default:
        if (p !== undefined && p >= 0x30 && p <= 0x39) {
          u = this.number(true);
          break;
        }
        throw this.peekError(p === undefined ? MSG.eofValue : MSG.value);
    }
    return this.fix(new JsonError(invalidType(u, schema, true)));
  }
}

function hexVal(b: number): number | undefined {
  if (b >= 0x30 && b <= 0x39) {
    return b - 0x30;
  }
  if (b >= 0x61 && b <= 0x66) {
    return b - 0x61 + 10;
  }
  if (b >= 0x41 && b <= 0x46) {
    return b - 0x41 + 10;
  }
  return undefined;
}

function peekValue(r: Reader): number {
  const p = r.ws();
  if (p === undefined) {
    throw r.peekError(MSG.eofValue);
  }
  return p;
}

function endSeq(r: Reader): void {
  const p = r.ws();
  if (p === 0x5d) {
    r.eat();
  } else if (p === 0x2c) {
    r.eat();
    throw r.ws() === 0x5d ? r.peekError(MSG.trailingComma) : r.peekError(MSG.trailing);
  } else if (p === undefined) {
    throw r.peekError(MSG.eofList);
  } else {
    throw r.peekError(MSG.trailing);
  }
}

function endMap(r: Reader): void {
  const p = r.ws();
  if (p === 0x7d) {
    r.eat();
  } else if (p === 0x2c) {
    r.eat();
    throw r.ws() === 0x7d ? r.peekError(MSG.trailingComma) : r.peekError(MSG.trailing);
  } else if (p === undefined) {
    throw r.peekError(MSG.eofObject);
  } else {
    throw r.peekError(MSG.trailing);
  }
}

/** Runs `body` (the visitor) and then the closing bracket, as `deserialize_seq/map/struct` do. */
function withEnd<T>(r: Reader, body: () => T, end: (r: Reader) => void): T {
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    result = { ok: true, value: body() };
  } catch (e) {
    result = { ok: false, error: e };
  }
  let endError: unknown;
  try {
    end(r);
  } catch (e) {
    endError = e;
  }
  if (!result.ok) {
    throw result.error instanceof JsonError ? r.fix(result.error) : result.error;
  }
  if (endError !== undefined) {
    throw endError instanceof JsonError ? r.fix(endError) : endError;
  }
  return result.value;
}

function seqNext(r: Reader, first: { v: boolean }): boolean {
  let p = r.ws();
  if (p === 0x5d) {
    return false;
  }
  if (p === 0x2c && !first.v) {
    r.eat();
    p = r.ws();
  } else if (p !== undefined) {
    if (first.v) {
      first.v = false;
    } else {
      throw r.peekError(MSG.listEnd);
    }
  } else {
    throw r.peekError(MSG.eofList);
  }
  if (p === 0x5d) {
    throw r.peekError(MSG.trailingComma);
  }
  if (p === undefined) {
    throw r.peekError(MSG.eofValue);
  }
  return true;
}

function mapNextKey(r: Reader, first: { v: boolean }): string | undefined {
  let p = r.ws();
  if (p === 0x7d) {
    return undefined;
  }
  if (p === 0x2c && !first.v) {
    r.eat();
    p = r.ws();
  } else if (p !== undefined) {
    if (first.v) {
      first.v = false;
    } else {
      throw r.peekError(MSG.objectEnd);
    }
  } else {
    throw r.peekError(MSG.eofObject);
  }
  if (p === 0x22) {
    r.eat();
    return r.str();
  }
  if (p === 0x7d) {
    throw r.peekError(MSG.trailingComma);
  }
  throw r.peekError(p === undefined ? MSG.eofValue : MSG.key);
}

function colon(r: Reader): void {
  const p = r.ws();
  if (p === 0x3a) {
    r.eat();
  } else {
    throw r.peekError(p === undefined ? MSG.eofObject : MSG.colon);
  }
}

function deserialize(r: Reader, schema: Schema, optional: boolean): Value {
  if (optional) {
    if (r.ws() === 0x6e) {
      r.eat();
      r.ident('ull');
      return null;
    }
  }
  const p = peekValue(r);
  switch (schema.k) {
    case 'string':
    case 'path':
      if (p === 0x22) {
        r.eat();
        return r.str();
      }
      throw r.invalidTypeOf(schema);
    case 'bool':
      if (p === 0x74) {
        r.eat();
        r.ident('rue');
        return true;
      }
      if (p === 0x66) {
        r.eat();
        r.ident('alse');
        return false;
      }
      throw r.invalidTypeOf(schema);
    case 'seq': {
      if (p !== 0x5b) {
        throw r.invalidTypeOf(schema);
      }
      r.eat();
      return withEnd(
        r,
        () => {
          const items: Value[] = [];
          const first = { v: true };
          while (seqNext(r, first)) {
            items.push(deserialize(r, schema.item, false));
          }
          return items;
        },
        endSeq,
      );
    }
    case 'stringMap': {
      if (p !== 0x7b) {
        throw r.invalidTypeOf(schema);
      }
      r.eat();
      return withEnd(
        r,
        () => {
          const map = new Map<string, string>();
          const first = { v: true };
          for (let key = mapNextKey(r, first); key !== undefined; key = mapNextKey(r, first)) {
            colon(r);
            map.set(key, deserialize(r, { k: 'string' }, false) as string);
          }
          return map;
        },
        endMap,
      );
    }
    case 'struct':
      if (p === 0x5b) {
        r.eat();
        return withEnd(r, () => structFromSeq(r, schema), endSeq);
      }
      if (p === 0x7b) {
        r.eat();
        return withEnd(r, () => structFromMap(r, schema), endMap);
      }
      throw r.invalidTypeOf(schema);
  }
}

function structFromSeq(r: Reader, schema: Schema & { k: 'struct' }): Struct {
  const out: Record<string, Value> = {};
  const first = { v: true };
  for (const [i, f] of schema.fields.entries()) {
    if (seqNext(r, first)) {
      out[f.name] = deserialize(r, f.schema, f.mode === 'option');
    } else if (f.mode === 'required' || f.mode === 'option') {
      throw new JsonError(invalidLength(i, schema));
    } else {
      out[f.name] = defaultOf(f.schema);
    }
  }
  return out;
}

function structFromMap(r: Reader, schema: Schema & { k: 'struct' }): Struct {
  const out: Record<string, Value> = {};
  const seen = new Set<string>();
  const first = { v: true };
  for (let key = mapNextKey(r, first); key !== undefined; key = mapNextKey(r, first)) {
    const f: FieldDef | undefined = schema.fields.find((x) => x.name === key);
    if (f === undefined) {
      throw new JsonError(unknownField(key, schema.fields));
    }
    if (seen.has(key)) {
      throw new JsonError(`duplicate field \`${key}\``);
    }
    seen.add(key);
    colon(r);
    out[key] = deserialize(r, f.schema, f.mode === 'option');
  }
  for (const f of schema.fields) {
    if (!seen.has(f.name)) {
      if (f.mode === 'required') {
        throw new JsonError(`missing field \`${f.name}\``);
      }
      out[f.name] = f.mode === 'option' ? null : defaultOf(f.schema);
    }
  }
  return out;
}

/** `serde_json::from_str::<PolicyConfig>`: the value, or serde_json's error Display text. */
export function parseJsonWithSchema(text: string, schema: Schema): Result<Value, string> {
  const r = new Reader(text);
  try {
    const value = deserialize(r, schema, false);
    if (r.ws() !== undefined) {
      throw r.peekError(MSG.trailing);
    }
    return ok(value);
  } catch (e) {
    if (e instanceof JsonError) {
      return err(r.fix(e).toString());
    }
    throw e;
  }
}
