/** Byte locations needed at the engine boundary; no guest code is decoded. */
export function wasmFunctions(bytes: Uint8Array):
  | {
      imports: { module: string; name: string; moduleStart: number }[];
      bodies: { start: number; end: number; index: number }[];
    }
  | undefined {
  let pos = 8;
  const uint = (): number => {
    let value = 0,
      shift = 0;
    for (;;) {
      const byte = bytes[pos++];
      if (byte === undefined) return Number.NaN;
      value += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) return value;
      shift += 7;
    }
  };
  const name = (): { text: string; start: number } => {
    const length = uint(),
      start = pos;
    pos += length;
    return { text: new TextDecoder().decode(bytes.subarray(start, pos)), start };
  };
  const valueType = (): void => {
    const type = bytes[pos++];
    if (type === 0x63 || type === 0x64) uint();
  };
  const limits = (): void => {
    const flags = uint();
    uint();
    if ((flags & 1) !== 0) uint();
    if ((flags & 8) !== 0) uint();
  };
  const imports: { module: string; name: string; moduleStart: number }[] = [];
  while (pos < bytes.length) {
    const section = bytes[pos++],
      length = uint(),
      end = pos + length;
    if (section === 2) {
      const count = uint();
      for (let i = 0; i < count; i++) {
        const module = name(),
          field = name();
        switch (bytes[pos++]) {
          case 0:
            uint();
            imports.push({ module: module.text, name: field.text, moduleStart: module.start });
            break;
          case 1:
            valueType();
            limits();
            break;
          case 2:
            limits();
            break;
          case 3:
            valueType();
            pos++;
            break;
          case 4:
            pos++;
            uint();
            break;
          default:
            return undefined;
        }
      }
    }
    if (section === 10) {
      const count = uint(),
        bodies = [];
      for (let i = 0; i < count; i++) {
        const size = uint();
        bodies.push({ start: pos, end: pos + size, index: imports.length + i });
        pos += size;
      }
      return { imports, bodies };
    }
    pos = end;
  }
  return { imports, bodies: [] };
}
