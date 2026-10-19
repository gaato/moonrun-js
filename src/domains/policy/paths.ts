import { err, type HostError, ok, type Result } from '../../ports/result.ts';

/** The one host operation the filesystem decisions need: `std::fs::canonicalize`. */
export interface CanonicalPort {
  /** `realpath(3)`: resolves every symlink and requires the whole path to exist. */
  realpath(path: string): Result<string, HostError>;
}

/** Marker for "could not be resolved"; moonrun maps every such failure to a denial. */
export type Unresolved = { readonly unresolved: true };

interface Components {
  readonly root: boolean;
  /** `.` only survives as the first component of a relative path, as in Rust's `Path::components`. */
  readonly parts: readonly string[];
}

function components(path: string): Components {
  const root = path.startsWith('/');
  const raw = path.split('/').filter((p) => p !== '');
  const parts = raw.filter((p, i) => p !== '.' || (i === 0 && !root));
  return { root, parts };
}

function build(root: boolean, parts: readonly string[]): string {
  return (root ? '/' : '') + parts.join('/');
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}

/** `PathBuf::join`: an absolute right-hand side replaces the left. */
export function joinPath(base: string, rel: string): string {
  if (isAbsolute(rel)) {
    return rel;
  }
  if (rel === '') {
    return base === '' ? '' : base.endsWith('/') ? base : `${base}/`;
  }
  if (base === '') {
    return rel;
  }
  return base.endsWith('/') ? base + rel : `${base}/${rel}`;
}

/** `Path::parent`. */
export function parentPath(path: string): string | undefined {
  const { root, parts } = components(path);
  if (parts.length === 0) {
    return undefined;
  }
  return build(root, parts.slice(0, -1));
}

/** `Path::file_name`: the last component when it is a normal name. */
export function fileName(path: string): string | undefined {
  const { parts } = components(path);
  const last = parts[parts.length - 1];
  return last === undefined || last === '.' || last === '..' ? undefined : last;
}

/** `Path::starts_with`: component-wise, so `/a/bc` does not start with `/a/b`. */
export function startsWithPath(path: string, prefix: string): boolean {
  const a = components(path);
  const b = components(prefix);
  return a.root === b.root && b.parts.every((part, i) => a.parts[i] === part);
}

/** `Path::ancestors`, longest first, ending with the root or the empty path. */
export function* ancestors(path: string): Generator<string> {
  const { root, parts } = components(path);
  for (let k = parts.length; k >= 1; k--) {
    yield build(root, parts.slice(0, k));
  }
  yield root ? '/' : '';
}

function stripPrefix(path: string, prefix: string): string[] | undefined {
  const a = components(path);
  const b = components(prefix);
  if (a.root !== b.root || !b.parts.every((part, i) => a.parts[i] === part)) {
    return undefined;
  }
  return a.parts.slice(b.parts.length);
}

/** moonrun's `normalize_path`: drops `.`, pops on `..` (never above the root). */
export function normalizePath(path: string): string {
  const { root, parts } = components(path);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return build(root, out);
}

/** moonrun's `canonicalize_existing_prefix`: realpath of the longest existing ancestor plus the rest. */
export function canonicalizeExistingPrefix(
  port: CanonicalPort,
  path: string,
): Result<string, Unresolved> {
  for (const ancestor of ancestors(path)) {
    const resolved = port.realpath(ancestor);
    if (resolved.ok) {
      const suffix = stripPrefix(path, ancestor);
      if (suffix === undefined) {
        return err({ unresolved: true });
      }
      return ok(normalizePath(joinPath(resolved.value, suffix.join('/'))));
    }
  }
  return err({ unresolved: true });
}

/** moonrun's `canonicalize_entry_path`: the final name is not followed (symlinks stay entries). */
export function canonicalizeEntryPath(
  port: CanonicalPort,
  path: string,
): Result<string, Unresolved> {
  const parent = parentPath(path);
  const name = fileName(path);
  if (parent === undefined || name === undefined) {
    return err({ unresolved: true });
  }
  const prefix = canonicalizeExistingPrefix(port, parent);
  if (!prefix.ok) {
    return prefix;
  }
  return ok(normalizePath(joinPath(prefix.value, name)));
}
