import { describe, expect, it } from 'vitest';
import { Diagnostics, type SourceMap } from '../../src/diagnostics/diag.ts';
import { nodeDiagnosticsModule } from '../../src/hosts/node/components.ts';

// moonrun's source_map.rs and wasm_diagnostic.rs (in moonrun-diag), through the component.

const enc = new TextEncoder();

function wasmWithSection(sectionName: string, payloadText: string): Uint8Array {
  const name = enc.encode(sectionName);
  const url = enc.encode(payloadText);
  const body = [name.length, ...name, url.length, ...url];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, body.length, ...body]);
}

const NO_SECTION = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

/** Diagnostics over an in-memory filesystem. */
function memoryDiagnostics(files: Map<string, string>): Diagnostics {
  return new Diagnostics(nodeDiagnosticsModule(), {
    readFile: (path) => {
      const text = files.get(path);
      return text === undefined ? undefined : enc.encode(text);
    },
  });
}

/** `SourceMap::position` as observed through `render`: `file:line` or undefined. */
function position(d: Diagnostics, map: SourceMap | undefined, offset: number) {
  const out = d.render(
    [{ kind: 'frame', indentation: '', fn: 'f', moduleOffset: offset }],
    map,
    false,
  );
  const m = /^at f (.+):(\d+)$/.exec(out);
  return m === null ? undefined : { file: m[1], line: Number(m[2]) };
}

/** A map parsed from `json` (as `/w.wasm.map` of a module without a section). */
function parse(json: string): { d: Diagnostics; map: SourceMap | undefined } {
  const d = memoryDiagnostics(new Map([['/w.wasm.map', json]]));
  return { d, map: d.loadSourceMap('/w.wasm', NO_SECTION) };
}

describe('SourceMap', () => {
  it('maps wasm offsets to the nearest source position', () => {
    const { d, map } = parse('{"sources":["main.mbt","lib.mbt"],"mappings":"AAAA,UCCA"}');
    expect(position(d, map, 9)).toEqual({ file: 'main.mbt', line: 1 });
    expect(position(d, map, 10)).toEqual({ file: 'lib.mbt', line: 2 });
  });

  it('rejects malformed source maps', () => {
    expect(parse('{"sources":[],"mappings":"?"}').map).toBeUndefined();
    expect(parse('not json').map).toBeUndefined();
  });

  it('returns no position before the first mapping or for unknown sources', () => {
    const { d, map } = parse('{"sources":["a.mbt"],"mappings":"UAAA,CCAA"}');
    expect(position(d, map, 8)).toBeUndefined();
    expect(position(d, map, 10)).toEqual({ file: 'a.mbt', line: 1 });
    expect(position(d, map, 11)).toBeUndefined(); // source index 1 is missing
  });

  it('only uses the first mappings line and skips segments without source info', () => {
    const { d, map } = parse('{"sources":["a.mbt"],"mappings":"A,CAAA;AAAA"}');
    expect(position(d, map, 0)).toBeUndefined();
    expect(position(d, map, 1)).toEqual({ file: 'a.mbt', line: 1 });
    expect(position(d, map, 100)).toEqual({ file: 'a.mbt', line: 1 });
  });

  it('rejects negative addresses on the first line and wrongly typed fields', () => {
    expect(parse('{"sources":["a"],"mappings":"DAAA"}').map).toBeUndefined();
    expect(parse('{"sources":[1],"mappings":""}').map).toBeUndefined();
    expect(parse('{"sources":[]}').map).toBeUndefined();
    expect(parse('[]').map).toBeUndefined();
  });

  it('decodes negative and multi-digit VLQ values', () => {
    // "gB" = 16 (two digits), "C" = +1 line, "D" = -1 line
    const { d, map } = parse('{"sources":["a"],"mappings":"gBACA,CADA"}');
    expect(position(d, map, 16)).toEqual({ file: 'a', line: 2 });
    expect(position(d, map, 17)).toEqual({ file: 'a', line: 1 });
  });
});

describe('loadSourceMap', () => {
  const mapJson = '{"version":3,"sources":["main.mbt"],"mappings":"AAAA"}';
  const expected = { file: 'main.mbt', line: 1 };

  it('resolves the section URL relative to the wasm directory', () => {
    const d = memoryDiagnostics(new Map([['/work/maps/original.map', mapJson]]));
    const map = d.loadSourceMap(
      '/work/main.wasm',
      wasmWithSection('sourceMappingURL', 'maps/original.map'),
    );
    expect(position(d, map, 0)).toEqual(expected);
  });

  it('keeps the source map after the files are removed', () => {
    const files = new Map([['/work/maps/original.map', mapJson]]);
    const d = memoryDiagnostics(files);
    const map = d.loadSourceMap(
      '/work/main.wasm',
      wasmWithSection('sourceMappingURL', 'maps/original.map'),
    );
    files.clear();
    expect(position(d, map, 0)).toEqual(expected);
  });

  it('uses absolute URLs as-is', () => {
    const d = memoryDiagnostics(new Map([['/abs/m.map', mapJson]]));
    const map = d.loadSourceMap(
      '/work/main.wasm',
      wasmWithSection('sourceMappingURL', '/abs/m.map'),
    );
    expect(position(d, map, 0)).toEqual(expected);
  });

  it('falls back to <wasm>.map for data:, http(s): and empty URLs and other sections', () => {
    const d = memoryDiagnostics(new Map([['/work/main.wasm.map', mapJson]]));
    for (const url of [
      'data:application/json;base64,e30=',
      'http://x/y.map',
      'https://x/y.map',
      '',
    ]) {
      const map = d.loadSourceMap('/work/main.wasm', wasmWithSection('sourceMappingURL', url));
      expect(position(d, map, 0)).toEqual(expected);
    }
    expect(position(d, d.loadSourceMap('/work/main.wasm', NO_SECTION), 0)).toEqual(expected);
    const other = d.loadSourceMap('/work/main.wasm', wasmWithSection('name', 'x'));
    expect(position(d, other, 0)).toEqual(expected);
  });

  it('does not fall back when the section URL is usable but unreadable', () => {
    const d = memoryDiagnostics(new Map([['/work/main.wasm.map', mapJson]]));
    const map = d.loadSourceMap(
      '/work/main.wasm',
      wasmWithSection('sourceMappingURL', 'missing.map'),
    );
    expect(map).toBeUndefined();
  });

  it('returns undefined for malformed map files', () => {
    const d = memoryDiagnostics(new Map([['/work/main.wasm.map', 'nope']]));
    expect(d.loadSourceMap('/work/main.wasm', new Uint8Array())).toBeUndefined();
  });
});

describe('render', () => {
  it('retains the runtime location after the mapped source position', () => {
    const { d, map } = parse('{"sources":["main.mbt"],"mappings":"AAAA"}');
    const location = 'wasm://wasm/abcd:wasm-function[42]:0x1234';
    const lines = [
      {
        kind: 'frame',
        indentation: '    ',
        fn: '_M0FP13pkg3foo',
        moduleOffset: 0x1234,
        runtimeLocation: location,
      },
    ] as const;
    expect(d.render(lines, map, false)).toBe(`    at @pkg.foo main.mbt:1 (${location})`);
    expect(d.render(lines, undefined, false)).toBe(`    at @pkg.foo (${location})`);
  });

  it('renders text and demangled frames, and hides frames without stack traces', () => {
    const d = memoryDiagnostics(new Map());
    const lines = [
      { kind: 'text', text: 'RuntimeError: unreachable' },
      { kind: 'frame', indentation: '    ', fn: '_M0FP13pkg3foo', moduleOffset: undefined },
    ] as const;
    expect(d.render(lines, undefined, false)).toBe('RuntimeError: unreachable\n    at @pkg.foo');
    expect(d.render(lines, undefined, true)).toBe('RuntimeError: unreachable');
  });
});
