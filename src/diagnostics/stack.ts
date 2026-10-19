/** Guest frames exposed by V8 (Node/Deno) and JavaScriptCore (Bun). */
export interface GuestFrame {
  readonly name: string;
  readonly location: string | undefined;
}

export function guestFrame(line: string): GuestFrame | undefined {
  const frame = line.trim().replace(/^at /, '');
  const open = frame.lastIndexOf(' (');
  if (frame.endsWith(')') && open >= 0) {
    const location = frame.slice(open + 2, -1);
    if (location.startsWith('wasm://') || location === '[wasm code]') {
      const name = frame.slice(0, open);
      return { name: name === '<anonymous>' ? '<anonymous>' : name, location };
    }
  }
  const at = frame.lastIndexOf('@');
  if (at >= 0 && frame.slice(at + 1) === '[wasm code]') {
    return { name: frame.slice(0, at) || '<anonymous>', location: undefined };
  }
  if (frame.startsWith('wasm://')) return { name: '<anonymous>', location: frame };
  // Bun 1.4.2 exposes neither names nor locations for wasm frames.
  if (frame === 'unknown') return { name: '<anonymous>', location: undefined };
  return undefined;
}
