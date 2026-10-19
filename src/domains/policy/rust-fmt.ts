/** Formatting helpers that reproduce Rust's `{:?}` / `Display` output where moonrun prints it. */

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
};

// Rust's `str` Debug escapes characters that are not printable (controls, format characters,
// separators other than the ASCII space, private use, unassigned, surrogates).
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Co}\p{Cn}\p{Cs}]/u;

/** Rust `format!("{:?}", s)` for a `str`: double quotes, `'` untouched. */
export function rustDebugStr(value: string): string {
  let out = '"';
  for (const ch of value) {
    const mapped = ESCAPES[ch];
    if (mapped !== undefined) {
      out += mapped;
    } else if (ch !== ' ' && NON_PRINTABLE.test(ch)) {
      out += `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

/** Rust `{:?}` for an `f64`. */
export function rustFloatDebug(x: number): string {
  if (Number.isNaN(x)) {
    return 'NaN';
  }
  if (!Number.isFinite(x)) {
    return x < 0 ? '-inf' : 'inf';
  }
  if (x === 0) {
    return Object.is(x, -0) ? '-0.0' : '0.0';
  }
  const abs = Math.abs(x);
  if (abs >= 1e16 || abs < 1e-4) {
    const [mantissa = '', exp = '0'] = x.toExponential().split('e');
    return `${mantissa}e${exp.replace('+', '')}`;
  }
  const s = String(x);
  return s.includes('.') ? s : `${s}.0`;
}

// Unicode White_Space as used by Rust's `str::trim` (differs from JS: includes U+0085, excludes U+FEFF).
const RUST_WS =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const TRIM_START = new RegExp(`^[${RUST_WS}]+`);
const TRIM = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g');

export function rustTrim(value: string): string {
  return value.replace(TRIM, '');
}

export function rustTrimStart(value: string): string {
  return value.replace(TRIM_START, '');
}

/** Rust `to_ascii_lowercase`: only A-Z change. */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Rust `u16::from_str`, returning the value or the `ParseIntError` Display text. */
export function parseU16(text: string): { ok: true; value: number } | { ok: false; error: string } {
  if (text === '') {
    return { ok: false, error: 'cannot parse integer from empty string' };
  }
  let digits = text;
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  } else if (digits.startsWith('-')) {
    // Unsigned types reject a minus sign as an invalid digit.
    return { ok: false, error: 'invalid digit found in string' };
  }
  if (digits === '') {
    return { ok: false, error: 'invalid digit found in string' };
  }
  if (!/^[0-9]+$/.test(digits)) {
    return { ok: false, error: 'invalid digit found in string' };
  }
  const value = Number(digits);
  if (value > 65535) {
    return { ok: false, error: 'number too large to fit in target type' };
  }
  return { ok: true, value };
}
