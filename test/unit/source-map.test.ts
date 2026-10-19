import { describe, expect, it } from 'vitest';

import {
  loadSourceMap,
  parseSourceMap,
  type SourceMapIo,
  sourceMappingUrl,
} from '../../src/diagnostics/source-map.ts';

const enc = new TextEncoder();

function wasmWithSection(sectionName: string, payloadText: string): Uint8Array {
  const name = enc.encode(sectionName);
  const url = enc.encode(payloadText);
  const body = [name.length, ...name, url.length, ...url];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, body.length, ...body]);
}

/** In-memory filesystem with posix-style resolve/dirname. */
function memoryIo(files: Map<string, string>): SourceMapIo {
  return {
    readText: (path) => files.get(path),
    resolve: (dir, rel) => (rel.startsWith('/') ? rel : dir === '' ? rel : `${dir}/${rel}`),
    dirname: (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)),
  };
}

describe('SourceMap', () => {
  it('maps wasm offsets to the nearest source position', () => {
    const map = parseSourceMap('{"sources":["main.mbt","lib.mbt"],"mappings":"AAAA,UCCA"}');
    expect(map?.position(9)).toEqual({ file: 'main.mbt', line: 1 });
    expect(map?.position(10)).toEqual({ file: 'lib.mbt', line: 2 });
  });

  it('rejects malformed source maps', () => {
    expect(parseSourceMap('{"sources":[],"mappings":"?"}')).toBeUndefined();
    expect(parseSourceMap('not json')).toBeUndefined();
  });

  it('returns undefined before the first mapping or for unknown sources', () => {
    const map = parseSourceMap('{"sources":["a.mbt"],"mappings":"UAAA,CCAA"}');
    expect(map?.position(8)).toBeUndefined();
    expect(map?.position(10)).toEqual({ file: 'a.mbt', line: 1 });
    expect(map?.position(11)).toBeUndefined(); // source index 1 is missing
  });

  it('only uses the first mappings line and skips segments without source info', () => {
    const map = parseSourceMap('{"sources":["a.mbt"],"mappings":"A,CAAA;AAAA"}');
    expect(map?.position(0)).toBeUndefined();
    expect(map?.position(1)).toEqual({ file: 'a.mbt', line: 1 });
    expect(map?.position(100)).toEqual({ file: 'a.mbt', line: 1 });
  });

  it('rejects negative addresses on the first line and wrongly typed fields', () => {
    expect(parseSourceMap('{"sources":["a"],"mappings":"DAAA"}')).toBeUndefined();
    expect(parseSourceMap('{"sources":[1],"mappings":""}')).toBeUndefined();
    expect(parseSourceMap('{"sources":[]}')).toBeUndefined();
    expect(parseSourceMap('[]')).toBeUndefined();
  });

  it('decodes negative and multi-digit VLQ values', () => {
    // "gB" = 16 (two digits), "C" = +1 line, "D" = -1 line
    const map = parseSourceMap('{"sources":["a"],"mappings":"gBACA,CADA"}');
    expect(map?.position(16)).toEqual({ file: 'a', line: 2 });
    expect(map?.position(17)).toEqual({ file: 'a', line: 1 });
  });
});

describe('sourceMappingUrl', () => {
  it('reads the custom section', () => {
    expect(sourceMappingUrl(wasmWithSection('sourceMappingURL', 'maps/x.map'))).toBe('maps/x.map');
  });

  it('ignores other custom sections and non-wasm input', () => {
    expect(sourceMappingUrl(wasmWithSection('name', 'x'))).toBeUndefined();
    expect(sourceMappingUrl(enc.encode('hello world'))).toBeUndefined();
    expect(sourceMappingUrl(new Uint8Array())).toBeUndefined();
  });

  it('gives up on truncated sections and invalid UTF-8', () => {
    const wasm = wasmWithSection('sourceMappingURL', 'abc');
    expect(sourceMappingUrl(wasm.subarray(0, wasm.length - 1))).toBeUndefined();
    const bad = wasm.slice();
    bad[bad.length - 1] = 0xff;
    expect(sourceMappingUrl(bad)).toBeUndefined();
  });
});

describe('loadSourceMap', () => {
  const mapJson = '{"version":3,"sources":["main.mbt"],"mappings":"AAAA"}';
  const expected = { file: 'main.mbt', line: 1 };

  it('resolves the section URL relative to the wasm directory', () => {
    const wasm = wasmWithSection('sourceMappingURL', 'maps/original.map');
    const io = memoryIo(new Map([['/work/maps/original.map', mapJson]]));
    expect(loadSourceMap('/work/main.wasm', wasm, io)?.position(0)).toEqual(expected);
  });

  it('keeps the source map after the files are removed', () => {
    const files = new Map([['/work/maps/original.map', mapJson]]);
    const wasm = wasmWithSection('sourceMappingURL', 'maps/original.map');
    const map = loadSourceMap('/work/main.wasm', wasm, memoryIo(files));
    files.clear();
    expect(map?.position(0)).toEqual(expected);
  });

  it('uses absolute URLs as-is', () => {
    const wasm = wasmWithSection('sourceMappingURL', '/abs/m.map');
    const io = memoryIo(new Map([['/abs/m.map', mapJson]]));
    expect(loadSourceMap('/work/main.wasm', wasm, io)?.position(0)).toEqual(expected);
  });

  it('falls back to <wasm>.map for data:, http(s): and empty URLs', () => {
    const io = memoryIo(new Map([['/work/main.wasm.map', mapJson]]));
    for (const url of [
      'data:application/json;base64,e30=',
      'http://x/y.map',
      'https://x/y.map',
      '',
    ]) {
      const wasm = wasmWithSection('sourceMappingURL', url);
      expect(loadSourceMap('/work/main.wasm', wasm, io)?.position(0)).toEqual(expected);
    }
    const noSection = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    expect(loadSourceMap('/work/main.wasm', noSection, io)?.position(0)).toEqual(expected);
  });

  it('does not fall back when the section URL is usable but unreadable', () => {
    const wasm = wasmWithSection('sourceMappingURL', 'missing.map');
    const io = memoryIo(new Map([['/work/main.wasm.map', mapJson]]));
    expect(loadSourceMap('/work/main.wasm', wasm, io)).toBeUndefined();
  });

  it('returns undefined for malformed map files', () => {
    const io = memoryIo(new Map([['/work/main.wasm.map', 'nope']]));
    expect(loadSourceMap('/work/main.wasm', new Uint8Array(), io)).toBeUndefined();
  });
});
