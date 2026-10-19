import type { FilePort } from '../../ports/files.ts';
import { fail, fromHostError, WasiErrno } from './errno.ts';
import { parent, samePath, startsWith } from './path.ts';

/** moonrun's `PathBoundaryMode`. */
export type BoundaryMode =
  | { readonly kind: 'follow-final'; readonly allowMissingFinal: boolean }
  | { readonly kind: 'parent-only' };

export function canonicalize(files: FilePort, path: string): string {
  const r = files.realpath(path);
  return r.ok ? r.value : fail(fromHostError(r.error));
}

export function ensureWithinRoot(root: string, path: string): void {
  if (!startsWith(path, root)) {
    fail(WasiErrno.NOTCAPABLE);
  }
}

/** Returns the canonical nearest existing ancestor and whether it is the immediate parent. */
function nearestExistingAncestor(files: FilePort, path: string): readonly [string, boolean] {
  const immediate = parent(path) ?? '.';
  let current = immediate;
  for (;;) {
    const r = files.realpath(current);
    if (r.ok) {
      return [r.value, samePath(current, immediate)];
    }
    if (r.error.code !== 'ENOENT') {
      fail(fromHostError(r.error));
    }
    const up = parent(current);
    if (up === undefined || samePath(up, current)) {
      fail(WasiErrno.NOENT);
    }
    current = up;
  }
}

function enforceParent(files: FilePort, root: string, path: string, allowMissing: boolean): void {
  const [ancestor, parentExists] = nearestExistingAncestor(files, path);
  ensureWithinRoot(root, ancestor);
  if (!(allowMissing && parentExists)) {
    fail(WasiErrno.NOENT);
  }
}

/** moonrun `enforce_path_boundary`. */
export function enforceBoundary(
  files: FilePort,
  root: string,
  path: string,
  mode: BoundaryMode,
): void {
  if (mode.kind === 'parent-only') {
    enforceParent(files, root, path, true);
    return;
  }
  const real = files.realpath(path);
  if (real.ok) {
    ensureWithinRoot(root, real.value);
    return;
  }
  if (real.error.code !== 'ENOENT') {
    fail(fromHostError(real.error));
  }
  const meta = files.lstat(path);
  if (meta.ok) {
    // A dangling symlink is refused whatever it points at.
    fail(meta.value.kind === 'symlink' ? WasiErrno.NOTCAPABLE : WasiErrno.NOENT);
  }
  if (meta.error.code !== 'ENOENT') {
    fail(fromHostError(meta.error));
  }
  enforceParent(files, root, path, mode.allowMissingFinal);
}

/** moonrun `reject_final_symlink`. */
export function rejectFinalSymlink(files: FilePort, path: string): void {
  const meta = files.lstat(path);
  if (meta.ok) {
    if (meta.value.kind === 'symlink') {
      fail(WasiErrno.LOOP);
    }
    return;
  }
  if (meta.error.code !== 'ENOENT') {
    fail(fromHostError(meta.error));
  }
}
