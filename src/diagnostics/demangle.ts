// Port of crates/moonutil/src/demangle.rs (moon @ 748b63c).
//
// The Rust code indexes the UTF-8 bytes of the symbol, so this port does too:
// the input is encoded to UTF-8 and every index below is a byte index.

type Parsed<T> = readonly [value: T, end: number] | undefined;

interface TypePath {
  pkg: string;
  typeName: string;
}

interface Suffix {
  text: string;
  end: number;
}

type Symbol =
  | {
      kind: 'function';
      pkg: string;
      name: string;
      before: string;
      typeArgs: string | undefined;
      after: string;
    }
  | {
      kind: 'method';
      type: TypePath;
      name: string;
      before: string;
      typeArgs: string | undefined;
      after: string;
    }
  | {
      kind: 'traitImpl';
      impl: TypePath;
      trait: TypePath;
      name: string;
      fnSuffix: string;
      typeArgs: string | undefined;
    }
  | {
      kind: 'extension';
      type: TypePath;
      methodPkg: string;
      name: string;
      before: string;
      typeArgs: string | undefined;
      after: string;
    }
  | { kind: 'local'; ident: string; stamp: string };

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const CH = {
  dollar: 0x24,
  at: 0x40,
  dot: 0x2e,
  underscore: 0x5f,
} as const;

function code(ch: string): number {
  return ch.charCodeAt(0);
}

/** Demangles a MoonBit function symbol, or returns it unchanged if it is not recognized. */
export function demangleMangledFunctionName(funcName: string): string {
  return demangleImpl(funcName) ?? funcName;
}

function demangleImpl(funcName: string): string | undefined {
  const s = encoder.encode(funcName);
  const parsed = parseMangledSymbol(s);
  if (parsed === undefined) return undefined;
  const [symbol, j] = parsed;
  if (j < s.length) {
    const c = s[j];
    if (c !== CH.dot && c !== CH.dollar && c !== CH.at) return undefined;
  }
  return renderSymbol(symbol);
}

function parseMangledSymbol(s: Uint8Array): Parsed<Symbol> {
  if (s.length === 0) return undefined;
  let i = 0;
  if (s[0] === CH.dollar) i = 1;
  if (s.length - i < 3) return undefined;
  if (s[i] !== CH.underscore || s[i + 1] !== code('M') || s[i + 2] !== code('0')) return undefined;
  i += 3;
  if (i >= s.length) return undefined;

  const tag = s[i];
  i += 1;
  switch (tag) {
    case code('F'):
      return parseFunctionSymbol(s, i);
    case code('M'):
      return parseMethodSymbol(s, i);
    case code('I'):
      return parseTraitImplMethodSymbol(s, i);
    case code('E'):
      return parseExtensionMethodSymbol(s, i);
    case code('L'):
      return parseLocalSymbol(s, i);
    default:
      return undefined;
  }
}

function parseFunctionSymbol(s: Uint8Array, i: number): Parsed<Symbol> {
  const pkg = parsePackage(s, i);
  if (!pkg) return undefined;
  const name = parseIdentifier(s, pkg[1]);
  if (!name) return undefined;
  const tail = parseSymbolTail(s, name[1]);
  if (!tail) return undefined;
  return [{ kind: 'function', pkg: pkg[0], name: name[0], ...tail.parts }, tail.end];
}

function parseMethodSymbol(s: Uint8Array, i: number): Parsed<Symbol> {
  const type = parseTypePath(s, i, false);
  if (!type) return undefined;
  const name = parseIdentifier(s, type[1]);
  if (!name) return undefined;
  const tail = parseSymbolTail(s, name[1]);
  if (!tail) return undefined;
  return [{ kind: 'method', type: type[0], name: name[0], ...tail.parts }, tail.end];
}

function parseTraitImplMethodSymbol(s: Uint8Array, i: number): Parsed<Symbol> {
  const impl = parseTypePath(s, i, false);
  if (!impl) return undefined;
  const trait = parseTypePath(s, impl[1], false);
  if (!trait) return undefined;
  const name = parseIdentifier(s, trait[1]);
  if (!name) return undefined;
  const tail = parseSymbolTail(s, name[1]);
  if (!tail) return undefined;
  const { before, after, typeArgs } = tail.parts;
  return [
    {
      kind: 'traitImpl',
      impl: impl[0],
      trait: trait[0],
      name: name[0],
      fnSuffix: before + after,
      typeArgs,
    },
    tail.end,
  ];
}

function parseExtensionMethodSymbol(s: Uint8Array, i: number): Parsed<Symbol> {
  const type = parseTypePath(s, i, true);
  if (!type) return undefined;
  const methodPkg = parsePackage(s, type[1]);
  if (!methodPkg) return undefined;
  const name = parseIdentifier(s, methodPkg[1]);
  if (!name) return undefined;
  const tail = parseSymbolTail(s, name[1]);
  if (!tail) return undefined;
  return [
    { kind: 'extension', type: type[0], methodPkg: methodPkg[0], name: name[0], ...tail.parts },
    tail.end,
  ];
}

/** fn suffix, optional type args, fn suffix: the part shared by every symbol kind but locals. */
function parseSymbolTail(
  s: Uint8Array,
  i: number,
):
  | { parts: { before: string; typeArgs: string | undefined; after: string }; end: number }
  | undefined {
  const before = parseFnSuffixText(s, i);
  if (!before) return undefined;
  const typeArgs = parseOptionalTypeArgsText(s, before.end);
  if (!typeArgs) return undefined;
  const after = parseFnSuffixText(s, typeArgs[1]);
  if (!after) return undefined;
  return {
    parts: { before: before.text, typeArgs: typeArgs[0], after: after.text },
    end: after.end,
  };
}

function parseLocalSymbol(s: Uint8Array, i: number): Parsed<Symbol> {
  let j = i;
  if (s[j] === code('m')) j += 1;

  const ident = parseIdentifier(s, j);
  if (!ident) return undefined;
  j = ident[1];

  if (s[j] !== code('S')) return undefined;
  j += 1;
  if (!isDigit(s[j])) return undefined;
  const stampStart = j;
  while (isDigit(s[j])) j += 1;
  return [{ kind: 'local', ident: ident[0], stamp: ascii(s, stampStart, j) }, j];
}

function parseFnSuffixText(s: Uint8Array, start: number): Suffix | undefined {
  let i = start;
  let text = '';

  while (s[i] === code('N')) {
    const nested = parseIdentifier(s, i + 1);
    if (!nested) return undefined;
    text += `.${nested[0]}`;
    i = nested[1];

    if (s[i] !== code('S')) return undefined;
    i += 1;
    if (!isDigit(s[i])) return undefined;
    const stampStart = i;
    while (isDigit(s[i])) i += 1;
    text += `[stamp=${ascii(s, stampStart, i)}]`;
  }

  if (s[i] === code('C')) {
    i += 1;
    if (!isDigit(s[i])) return undefined;
    const uuidStart = i;
    while (isDigit(s[i])) i += 1;
    text += `.anonymous[uuid=${ascii(s, uuidStart, i)}`;

    // New schema carries optional line info as `l<line>`.
    if (s[i] === code('l')) {
      i += 1;
      const lineStart = i;
      if (!isDigit(s[i])) return undefined;
      while (isDigit(s[i])) i += 1;
      text += `,line=${ascii(s, lineStart, i)}`;
    }
    text += ']';
  }

  return { text, end: i };
}

function parseTypePath(s: Uint8Array, i: number, omitCorePrefix: boolean): Parsed<TypePath> {
  const pkgParsed = parsePackage(s, i);
  if (!pkgParsed) return undefined;
  let pkg = pkgParsed[0];
  const ident = parseIdentifier(s, pkgParsed[1]);
  if (!ident) return undefined;
  let typeName = ident[0];
  let k = ident[1];

  if (s[k] === code('L')) {
    const local = parseIdentifier(s, k + 1);
    if (!local) return undefined;
    typeName += `.${local[0]}`;
    k = local[1];
  }

  if (omitCorePrefix && isCorePackage(pkg)) pkg = '';
  return [{ pkg, typeName }, k];
}

function parseTypeRefText(s: Uint8Array, i: number): Parsed<string> {
  const path = parseTypePath(s, i, false);
  if (!path) return undefined;
  let text = renderTypePath(path[0]);
  let j = path[1];
  if (s[j] === code('G')) {
    const args = parseTypeArgsText(s, j);
    if (!args) return undefined;
    text += args[0];
    j = args[1];
  }
  return [text, j];
}

function parseTypeListUntilE(s: Uint8Array, start: number): Parsed<string[]> {
  const items: string[] = [];
  let i = start;
  while (s[i] !== code('E')) {
    const item = parseTypeText(s, i);
    if (!item) return undefined;
    items.push(item[0]);
    i = item[1];
  }
  return [items, i + 1];
}

function parseFnTypeText(s: Uint8Array, i: number): Parsed<string> {
  let j = i;
  const isAsync = s[j] === code('V');
  if (isAsync) j += 1;
  const isNocancel = isAsync && s[j] === code('N');
  if (isNocancel) j += 1;
  const isRaw = s[j] === code('X');
  if (isRaw) j += 1;
  if (s[j] !== code('W')) return undefined;

  const params = parseTypeListUntilE(s, j + 1);
  if (!params) return undefined;
  j = params[1];

  const ret = parseTypeText(s, j);
  if (!ret) return undefined;
  j = ret[1];

  let raises = '';
  if (s[j] === code('Q')) {
    const raised = parseTypeText(s, j + 1);
    if (!raised) return undefined;
    raises = ` raise ${raised[0]}`;
    j = raised[1];
  }

  const asyncPrefix = isAsync ? 'async ' : '';
  let nocancelSuffix = '';
  if (isNocancel) nocancelSuffix = raises === '' ? ' nocancel' : ' + nocancel';
  const signature = `${asyncPrefix}(${params[0].join(', ')}) -> ${ret[0]}${raises}${nocancelSuffix}`;
  return [isRaw ? `FuncRef[${signature}]` : signature, j];
}

function parseTypeArgsText(s: Uint8Array, i: number): Parsed<string> {
  let j = i;
  let argsPrefix = '';

  if (s[j] === code('G')) {
    const args = parseTypeListUntilE(s, j + 1);
    if (!args) return undefined;
    argsPrefix = `[${args[0].join(', ')}]`;
    j = args[1];
  }

  let raiseSuffix = '';
  if (s[j] === code('H')) {
    const raised = parseTypeText(s, j + 1);
    if (!raised) return undefined;
    raiseSuffix = ` raise ${raised[0]}`;
    j = raised[1];
  }

  return [argsPrefix + raiseSuffix, j];
}

function parseOptionalTypeArgsText(s: Uint8Array, i: number): Parsed<string | undefined> {
  if (s[i] === code('G') || s[i] === code('H')) {
    const args = parseTypeArgsText(s, i);
    if (!args) return undefined;
    return [args[0], args[1]];
  }
  return [undefined, i];
}

const SIMPLE_TYPES: ReadonlyMap<number, string> = new Map([
  [code('i'), 'Int'],
  [code('l'), 'Int64'],
  [code('h'), 'Int16'],
  [code('j'), 'UInt'],
  [code('k'), 'UInt16'],
  [code('m'), 'UInt64'],
  [code('d'), 'Double'],
  [code('f'), 'Float'],
  [code('b'), 'Bool'],
  [code('c'), 'Char'],
  [code('s'), 'String'],
  [code('u'), 'Unit'],
  [code('y'), 'Byte'],
  [code('z'), 'Bytes'],
  [code('v'), 'V128'],
]);

const WRAPPER_TYPES: ReadonlyMap<number, string> = new Map([
  [code('A'), 'FixedArray'],
  [code('N'), 'ReadOnlyArray'],
  [code('O'), 'Option'],
]);

function parseTypeText(s: Uint8Array, i: number): Parsed<string> {
  const c = s[i];
  if (c === undefined) return undefined;

  const simple = SIMPLE_TYPES.get(c);
  if (simple !== undefined) return [simple, i + 1];

  const wrapper = WRAPPER_TYPES.get(c);
  if (wrapper !== undefined) {
    const inner = parseTypeText(s, i + 1);
    if (!inner) return undefined;
    return [`${wrapper}[${inner[0]}]`, inner[1]];
  }

  switch (c) {
    case code('U'): {
      const elems = parseTypeListUntilE(s, i + 1);
      if (!elems) return undefined;
      return [`(${elems[0].join(', ')})`, elems[1]];
    }
    case code('V'):
    case code('X'):
    case code('W'):
      return parseFnTypeText(s, i);
    case code('R'):
      return parseTypeRefText(s, i + 1);
    default:
      return undefined;
  }
}

function renderSymbol(symbol: Symbol): string {
  switch (symbol.kind) {
    case 'function':
      return (
        renderQualifiedName(symbol.pkg, symbol.name) +
        symbol.before +
        (symbol.typeArgs ?? '') +
        symbol.after
      );
    case 'method':
      return (
        `${renderTypePath(symbol.type)}::${symbol.name}` +
        symbol.before +
        (symbol.typeArgs ?? '') +
        symbol.after
      );
    case 'traitImpl':
      return (
        `impl ${renderTypePath(symbol.trait)} for ${renderTypePath(symbol.impl)}` +
        (symbol.typeArgs ?? '') +
        ` with ${symbol.name}${symbol.fnSuffix}`
      );
    case 'extension': {
      const typeText = renderTypePath(symbol.type);
      let text: string;
      if (symbol.methodPkg === '') {
        text = typeText;
      } else {
        const typeUse = typeText.startsWith('@') ? typeText.slice(1) : typeText;
        text = `@${symbol.methodPkg}.${typeUse}`;
      }
      return `${text}::${symbol.name}${symbol.before}${symbol.typeArgs ?? ''}${symbol.after}`;
    }
    case 'local': {
      const noDollar = symbol.ident.startsWith('$') ? symbol.ident.slice(1) : symbol.ident;
      const shown = noDollar.endsWith('.fn') ? noDollar.slice(0, -3) : noDollar;
      return shown.includes('/') ? `@${shown}/${symbol.stamp}` : `${shown}/${symbol.stamp}`;
    }
  }
}

function renderTypePath(path: TypePath): string {
  return renderQualifiedName(path.pkg, path.typeName);
}

function renderQualifiedName(pkg: string, name: string): string {
  return pkg === '' ? name : `@${pkg}.${name}`;
}

function parsePackage(s: Uint8Array, start: number): Parsed<string> {
  let i = start;
  if (s[i] !== code('P')) return undefined;
  i += 1;

  if (s[i] === code('B')) return ['moonbitlang/core/builtin', i + 1];

  if (s[i] === code('C')) {
    const counted = parseCountedPackageSegments(s, i + 1);
    if (!counted) return undefined;
    const [suffix, end] = counted;
    return [suffix === '' ? 'moonbitlang/core' : `moonbitlang/core/${suffix}`, end];
  }

  return parseCountedPackageSegments(s, i);
}

function parseCountedPackageSegments(s: Uint8Array, i: number): Parsed<string> {
  // In v0 the count is not delimited from the first segment length. Keep the
  // established one-digit interpretation until the format is made unambiguous.
  const digit = s[i];
  if (digit === undefined || !isDigit(digit)) return undefined;
  return parsePackageSegments(s, i + 1, digit - code('0'));
}

function parsePackageSegments(s: Uint8Array, start: number, count: number): Parsed<string> {
  const segs: string[] = [];
  let i = start;
  for (let n = 0; n < count; n++) {
    const seg = parseIdentifier(s, i);
    if (!seg) return undefined;
    segs.push(seg[0]);
    i = seg[1];
  }
  return [segs.join('/'), i];
}

function parseIdentifier(s: Uint8Array, i: number): Parsed<string> {
  const len = parseU32(s, i);
  if (!len) return undefined;
  const start = len[1];
  const end = start + len[0];
  if (end > s.length) return undefined;
  const out = decodeIdentifierBytes(s.subarray(start, end));
  return out === undefined ? undefined : [out, end];
}

function parseU32(s: Uint8Array, start: number): Parsed<number> {
  if (!isDigit(s[start])) return undefined;
  let i = start;
  let v = 0;
  for (let c = s[i]; c !== undefined && isDigit(c); c = s[i]) {
    v = v * 10 + (c - code('0'));
    if (v > 0xffff_ffff) return undefined;
    i += 1;
  }
  return [v, i];
}

function hexValue(ch: number | undefined): number | undefined {
  if (ch === undefined) return undefined;
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x61 && ch <= 0x66) return 10 + ch - 0x61;
  if (ch >= 0x41 && ch <= 0x46) return 10 + ch - 0x41;
  return undefined;
}

function isCorePackage(pkg: string): boolean {
  const prefix = 'moonbitlang/core';
  return pkg === prefix || pkg.startsWith(`${prefix}/`);
}

function isDigit(ch: number | undefined): boolean {
  return ch !== undefined && ch >= 0x30 && ch <= 0x39;
}

function ascii(s: Uint8Array, start: number, end: number): string {
  return utf8.decode(s.subarray(start, end));
}

function decodeIdentifierBytes(raw: Uint8Array): string | undefined {
  const out: number[] = [];
  let k = 0;
  while (k < raw.length) {
    const c = raw[k];
    if (c === undefined) return undefined;
    if (c !== CH.underscore) {
      out.push(c);
      k += 1;
      continue;
    }

    const next = raw[k + 1];
    if (next === undefined) return undefined;
    if (next === CH.underscore) {
      out.push(CH.underscore);
      k += 2;
      continue;
    }

    const hi = hexValue(next);
    if (hi === undefined) return undefined;
    const lo = hexValue(raw[k + 2]);
    if (lo === undefined) return undefined;
    out.push((hi << 4) | lo);
    k += 3;
  }
  try {
    return utf8.decode(new Uint8Array(out));
  } catch {
    return undefined;
  }
}
