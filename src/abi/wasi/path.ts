/**
 * The parts of Rust's `std::path::Path` (Unix flavour) that moonrun's WASI relies
 * on. Paths are never normalized lexically: `..` must keep its physical meaning
 * when the OS resolves it.
 */
type Component =
  | { readonly kind: 'root' }
  | { readonly kind: 'cur' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'normal'; readonly name: string };

/** `Path::components`: drops empty and interior `.` parts; a leading `.` is kept. */
function components(path: string): Component[] {
  const out: Component[] = [];
  const rooted = path.startsWith('/');
  if (rooted) {
    out.push({ kind: 'root' });
  }
  path.split('/').forEach((part, i) => {
    if (part === '') {
      return;
    }
    if (part === '.') {
      if (i === 0) {
        out.push({ kind: 'cur' });
      }
      return;
    }
    out.push(part === '..' ? { kind: 'parent' } : { kind: 'normal', name: part });
  });
  return out;
}

function format(parts: readonly Component[]): string {
  const [first, ...rest] = parts;
  const names = (cs: readonly Component[]): string[] =>
    cs.map((c) => (c.kind === 'normal' ? c.name : c.kind === 'parent' ? '..' : '.'));
  if (first?.kind === 'root') {
    return `/${names(rest).join('/')}`;
  }
  return names(parts).join('/');
}

function same(a: Component, b: Component): boolean {
  return a.kind === b.kind && (a.kind !== 'normal' || (b.kind === 'normal' && a.name === b.name));
}

/** `Path::parent`: `None` for `/` and the empty path. */
export function parent(path: string): string | undefined {
  const parts = components(path);
  const last = parts.pop();
  if (last === undefined || last.kind === 'root') {
    return undefined;
  }
  return format(parts);
}

/** `Path::file_name`: the final component when it is a normal name. */
export function fileName(path: string): string | undefined {
  const last = components(path).at(-1);
  return last?.kind === 'normal' ? last.name : undefined;
}

/** `PathBuf::push`: an absolute `path` replaces `base`; no normalization. */
export function join(base: string, path: string): string {
  if (path.startsWith('/')) {
    return path;
  }
  return base === '' || base.endsWith('/') ? base + path : `${base}/${path}`;
}

/** `Path::starts_with`: component-wise prefix. */
export function startsWith(path: string, prefix: string): boolean {
  const p = components(path);
  const q = components(prefix);
  return (
    q.length <= p.length &&
    q.every((c, i) => {
      const d = p[i];
      return d !== undefined && same(c, d);
    })
  );
}

/** `Path` equality, which compares components. */
export function samePath(a: string, b: string): boolean {
  return startsWith(a, b) && components(a).length === components(b).length;
}
