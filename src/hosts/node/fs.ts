import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileKind, FsPort } from '../../ports/fs.ts';
import {
  err,
  type HostError,
  type HostErrorCode,
  hostError,
  ok,
  type Result,
} from '../../ports/result.ts';

export function toHostError(e: unknown): HostError {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') {
    const message = 'message' in e && typeof e.message === 'string' ? e.message : undefined;
    return hostError(e.code as HostErrorCode, message);
  }
  return hostError('EIO', String(e));
}

function attempt<T>(f: () => T): Result<T, HostError> {
  try {
    return ok(f());
  } catch (e) {
    return err(toHostError(e));
  }
}

function kindOf(stat: fs.Stats): FileKind {
  return stat.isFile()
    ? 'file'
    : stat.isDirectory()
      ? 'dir'
      : stat.isSymbolicLink()
        ? 'symlink'
        : 'other';
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Names in directory order (not sorted, like Rust's `read_dir`); entries whose names are not
 * UTF-8 are skipped. Names are read as latin1 to keep the raw bytes.
 */
function readDirNames(dir: string): string[] {
  const names: string[] = [];
  const handle = fs.opendirSync(dir, { encoding: 'latin1', bufferSize: 32 });
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      try {
        const name: unknown = entry;
        const value = typeof name === 'string' || name instanceof Uint8Array ? name : entry.name;
        names.push(
          utf8.decode(
            typeof value === 'string'
              ? Buffer.from(value, process.versions['deno'] === undefined ? 'latin1' : 'utf8')
              : value,
          ),
        );
      } catch {
        // Not UTF-8: Rust's `to_str()` filters these out.
      }
    }
  } finally {
    handle.closeSync();
  }
  return names;
}

/** Like Rust `remove_dir_all`: a symlink is unlinked, anything else must be a directory. */
function removeDirAll(target: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
  } else if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true });
  } else {
    throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
  }
}

export function nodeFs(cwd: string = process.cwd()): FsPort {
  const resolve = (p: string): string => path.resolve(cwd, p);
  return {
    cwd: () => ok(cwd),
    resolve,
    readFile: (p) => attempt(() => new Uint8Array(fs.readFileSync(resolve(p)))),
    writeFile: (p, data) => attempt(() => fs.writeFileSync(resolve(p), data)),
    mkdirAll: (p) =>
      attempt(() => {
        fs.mkdirSync(resolve(p), { recursive: true });
      }),
    readDir: (p) => attempt(() => readDirNames(resolve(p))),
    removeFile: (p) => attempt(() => fs.unlinkSync(resolve(p))),
    removeDirAll: (p) => attempt(() => removeDirAll(resolve(p))),
    kind: (p) => attempt(() => kindOf(fs.statSync(resolve(p)))),
  };
}
