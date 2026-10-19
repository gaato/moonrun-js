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
    readDir: (p) => attempt(() => fs.readdirSync(resolve(p))),
    removeFile: (p) => attempt(() => fs.unlinkSync(resolve(p))),
    removeDirAll: (p) => attempt(() => fs.rmSync(resolve(p), { recursive: true })),
    kind: (p) => attempt(() => kindOf(fs.statSync(resolve(p)))),
  };
}
