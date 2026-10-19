import { ok, type Result } from '../../ports/result.ts';
import { type PolicyDenied, sandboxDenied } from './denial.ts';
import {
  type CanonicalPort,
  canonicalizeEntryPath,
  canonicalizeExistingPrefix,
  isAbsolute,
  joinPath,
  startsWithPath,
} from './paths.ts';
import { rustDebugStr } from './rust-fmt.ts';

export type FsRoot = { readonly kind: 'any' } | { readonly kind: 'path'; readonly path: string };

/** `[fs]` after root canonicalization. An empty rule list denies that access kind. */
export interface FsPolicy {
  readonly read: readonly FsRoot[];
  readonly write: readonly FsRoot[];
}

export interface FsIntents {
  readonly read: boolean;
  readonly write: boolean;
}

export const READ: FsIntents = { read: true, write: false };
export const WRITE: FsIntents = { read: false, write: true };

/** `FsIntents::for_open(access, create_mode, append)`; access 0|3 read, 1 write, anything else rw. */
export function intentsForOpen(access: number, createMode: number, append: boolean): FsIntents {
  let read = true;
  let write = true;
  if (access === 0 || access === 3) {
    write = false;
  } else if (access === 1) {
    read = false;
  }
  return { read, write: write || createMode !== 0 || append };
}

/** `FsIntents::for_access_check(access)`: only `W_OK` (2) needs write. */
export function intentsForAccessCheck(access: number): FsIntents {
  return access === 2 ? WRITE : READ;
}

export function rootsFromConfig(roots: readonly string[]): FsRoot[] {
  return roots.map((p): FsRoot => (p === '*' ? { kind: 'any' } : { kind: 'path', path: p }));
}

function allows(roots: readonly FsRoot[], path: string): boolean {
  return roots.some((r) => r.kind === 'any' || path === r.path || startsWithPath(path, r.path));
}

function sandboxAction(intents: FsIntents): string {
  if (intents.read && !intents.write) {
    return 'file read';
  }
  if (!intents.read && intents.write) {
    return 'file write';
  }
  return 'file access';
}

/**
 * `FsPolicy::authorize`. `resolved` is the canonical absolute path, or `undefined` when it could
 * not be established (always a denial). `target` is the already quoted text shown to the user.
 */
export function authorizeResolved(
  policy: FsPolicy,
  resolved: string | undefined,
  intents: FsIntents,
  target: string,
): Result<void, PolicyDenied> {
  if (resolved === undefined) {
    return sandboxDenied(sandboxAction(intents), target);
  }
  if (intents.read && !allows(policy.read, resolved)) {
    return sandboxDenied('file read', target);
  }
  if (intents.write && !allows(policy.write, resolved)) {
    return sandboxDenied('file write', target);
  }
  return ok(undefined);
}

/** Quoting used in denial targets: `format!("{:?}", path.to_string_lossy())`. */
export const quotePath = rustDebugStr;

/** Text shown for a resource without a tracked path. */
export const UNTRACKED_RESOURCE = '"<untracked resource>"';

export interface FsAuthorityOptions {
  /** `undefined` means no policy: every check passes without touching the filesystem. */
  readonly policy: FsPolicy | undefined;
  readonly canonical: CanonicalPort;
  /** `WorkingDirectory::resolve`: absolute paths pass through, relative ones join the cwd. */
  readonly resolve: (path: string) => string | undefined;
}

/**
 * The filesystem half of the sandbox, one method per `HostFs::authorize_*` in moonrun
 * (filesystem/mod.rs:317-442). Call these at the last safe moment: right before the host
 * operation (for async jobs, when the job runs, not when it is created).
 */
export class FsAuthority {
  private readonly options: FsAuthorityOptions;
  constructor(options: FsAuthorityOptions) {
    this.options = options;
  }

  get enforced(): boolean {
    return this.options.policy !== undefined;
  }

  private check(
    resolved: string | undefined,
    intents: FsIntents,
    target: string,
  ): Result<void, PolicyDenied> {
    const { policy } = this.options;
    return policy === undefined
      ? ok(undefined)
      : authorizeResolved(policy, resolved, intents, target);
  }

  private existingPrefix(path: string): string | undefined {
    const resolved = this.options.resolve(path);
    if (resolved === undefined) {
      return undefined;
    }
    const c = canonicalizeExistingPrefix(this.options.canonical, resolved);
    return c.ok ? c.value : undefined;
  }

  private entryPath(path: string): string | undefined {
    const resolved = this.options.resolve(path);
    if (resolved === undefined) {
      return undefined;
    }
    const c = canonicalizeEntryPath(this.options.canonical, resolved);
    return c.ok ? c.value : undefined;
  }

  /** `authorize_path`: follows symlinks in the final component (longest existing prefix). */
  private path(path: string, intents: FsIntents): Result<void, PolicyDenied> {
    if (!this.enforced) {
      return ok(undefined);
    }
    return this.check(this.existingPrefix(path), intents, quotePath(path));
  }

  /** `authorize_entry`: the final component is the entry itself (remove, rename, mkdir, lstat). */
  private entry(path: string, intents: FsIntents): Result<void, PolicyDenied> {
    if (!this.enforced) {
      return ok(undefined);
    }
    return this.check(this.entryPath(path), intents, quotePath(path));
  }

  authorizeOpen(
    path: string,
    access: number,
    createMode: number,
    append: boolean,
  ): Result<void, PolicyDenied> {
    return this.path(path, intentsForOpen(access, createMode, append));
  }

  /** Metadata, realpath, inotify watches and the legacy `ensure_read`. */
  authorizeRead(path: string): Result<void, PolicyDenied> {
    return this.path(path, READ);
  }

  /** chmod and SQLite's parent-directory write check. */
  authorizeWrite(path: string): Result<void, PolicyDenied> {
    return this.path(path, WRITE);
  }

  authorizeAccess(path: string, access: number): Result<void, PolicyDenied> {
    return this.path(path, intentsForAccessCheck(access));
  }

  /** unlink/rmdir/remove: write on the entry, not on what a symlink points to. */
  authorizeRemove(path: string): Result<void, PolicyDenied> {
    return this.entry(path, WRITE);
  }

  /** symlink, mkdir, rmdir jobs. */
  authorizeWriteEntry(path: string): Result<void, PolicyDenied> {
    return this.entry(path, WRITE);
  }

  /** Both names are checked, the old one first. */
  authorizeRename(oldPath: string, newPath: string): Result<void, PolicyDenied> {
    const first = this.entry(oldPath, WRITE);
    return first.ok ? this.entry(newPath, WRITE) : first;
  }

  /** lstat-style metadata without a base directory. */
  authorizeEntryMetadata(path: string): Result<void, PolicyDenied> {
    return this.entry(path, READ);
  }

  /**
   * `authorize_metadata_at` / `authorize_entry_metadata_at`: a path relative to an open
   * directory. `base` is that directory's tracked canonical path (`undefined` when untracked,
   * which denies relative paths and shows `"<untracked resource>"`).
   */
  authorizeMetadataAt(
    base: string | undefined,
    path: string,
    followSymlink: boolean,
  ): Result<void, PolicyDenied> {
    if (!this.enforced) {
      return ok(undefined);
    }
    const target = base === undefined ? UNTRACKED_RESOURCE : quotePath(path);
    let resolved: string | undefined;
    if (isAbsolute(path)) {
      resolved = path;
    } else if (base !== undefined) {
      resolved = joinPath(base, path);
    }
    let canonical: string | undefined;
    if (resolved !== undefined) {
      const c = followSymlink
        ? canonicalizeExistingPrefix(this.options.canonical, resolved)
        : canonicalizeEntryPath(this.options.canonical, resolved);
      canonical = c.ok ? c.value : undefined;
    }
    return this.check(canonical, READ, target);
  }

  /** fstat/file size/file time on an open file: `canonicalPath` is what the open recorded. */
  authorizeResourceMetadata(canonicalPath: string | undefined): Result<void, PolicyDenied> {
    return this.resource(canonicalPath, READ);
  }

  /** flock: only an exclusive lock needs (write) authorization. */
  authorizeResourceLock(
    canonicalPath: string | undefined,
    exclusive: boolean,
  ): Result<void, PolicyDenied> {
    return exclusive ? this.resource(canonicalPath, WRITE) : ok(undefined);
  }

  private resource(
    canonicalPath: string | undefined,
    intents: FsIntents,
  ): Result<void, PolicyDenied> {
    if (!this.enforced) {
      return ok(undefined);
    }
    if (canonicalPath === undefined) {
      return this.check(undefined, intents, UNTRACKED_RESOURCE);
    }
    const c = canonicalizeExistingPrefix(this.options.canonical, canonicalPath);
    return this.check(c.ok ? c.value : undefined, intents, quotePath(canonicalPath));
  }
}
