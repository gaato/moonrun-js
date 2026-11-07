// One Run's sandbox policy, environment and Host Filesystem, from the moonrun-policy
// component (crates/moonrun-policy: upstream policy/**, runtime/environment*.rs,
// runtime/working_directory.rs, filesystem/{mod,grant,host}.rs and
// unstable_api/filesystem.rs, verbatim). The component decides
// and renders moonrun's texts; it reaches the OS only through the capabilities given at
// construction (crates/os). See WIRING.md for where each check is consulted.
import { ComponentAbi, nulList, utf8 } from '../../components/abi.ts';
import { type OsBinding, type OsCapabilities, osImports } from '../../components/os.ts';
import { type AsyncError, BADF, FAULT, INVAL, IO, PERMISSION_DENIED } from '../../kernel/errors.ts';
import type { FilesystemPayload } from '../../kernel/job.ts';
import { encodeSockaddr } from '../../kernel/net-codec.ts';
import type { NetworkRequest } from '../../kernel/network.ts';
import type { Resource } from '../../kernel/resource.ts';
import type { EnvPort } from '../../ports/env.ts';
import { err, ok, type Result } from '../../ports/result.ts';

/** A WASI path operation's HostFs check (`checkWasi`). */
export type WasiCheck =
  | {
      readonly kind: 'open-file';
      readonly base: string;
      readonly path: string;
      readonly read: boolean;
      readonly write: boolean;
    }
  | { readonly kind: 'open-directory'; readonly base: string; readonly path: string }
  | {
      readonly kind: 'read-link' | 'create-directory' | 'read-directory';
      readonly hostPath: string;
    }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'remove-at'; readonly base: string; readonly path: string };

/** An `anyhow` error chain, outermost context first. */
export interface PolicyError {
  readonly chain: readonly string[];
}

/** A legacy whole-file operation's failure text (what the import panics with). */
export type FsOutcome<T> = Result<T, string>;

const UNTRACKED = -1; // ABSENT: FileGrant::UNTRACKED
const NO_CANONICAL_PATH = -2; // usize::MAX - 1: a file opened without a recorded path
const STDIO = -3; // usize::MAX - 2: FileGrant::STDIO

/** The selected policy's execution-session requests (moonrun `RunOptions`). */
export interface PolicySession {
  /** `process.virtualize`. */
  readonly virtualize: boolean;
  /** `process.ipc`. */
  readonly ipc: boolean;
}

/** Component status codes (`abi.rs` `host_code`) as kernel errors. */
function hostError(code: number): AsyncError | undefined {
  switch (code) {
    case 0:
      return undefined;
    case 1:
      return FAULT;
    case 2:
      return INVAL;
    case 3:
      return IO;
    case 4:
      return BADF;
    case 5:
      return PERMISSION_DENIED;
    default:
      return IO;
  }
}

export class PolicyComponent {
  readonly #abi: ComponentAbi;
  #enforced = false;

  constructor(module: WebAssembly.Module, caps: OsCapabilities) {
    let binding: OsBinding | undefined;
    const imports = osImports(caps, () => {
      if (binding === undefined) {
        throw new Error('moonrun-policy: import called during instantiation');
      }
      return binding;
    });
    const instance = new WebAssembly.Instance(module, imports);
    binding = instance.exports as unknown as OsBinding;
    this.#abi = new ComponentAbi(instance, 'policy');
  }

  /** True once a policy (file or inherited) is in force. */
  get enforced(): boolean {
    return this.#enforced;
  }

  #installed(code: number): Result<void, PolicyError> {
    if (code === 0) {
      this.#enforced = true;
      return ok(undefined);
    }
    return err({ chain: JSON.parse(this.#abi.resultText()) as string[] });
  }

  /**
   * `--policy PATH [--policy-source-dir DIR]`, read and resolved before the Wasm is
   * loaded (moonrun `RunOptions::with_policy_file_source_dir`). Returns the file's
   * execution-session requests.
   */
  select(
    path: Uint8Array | string,
    sourceDir?: Uint8Array | string,
  ): Result<PolicySession, PolicyError> {
    if (this.#abi.call('policy_select', path, sourceDir) !== 0) {
      return err({ chain: JSON.parse(this.#abi.resultText()) as string[] });
    }
    const bits = this.#abi.result()[0] ?? 0;
    return ok({ virtualize: (bits & 1) !== 0, ipc: (bits & 2) !== 0 });
  }

  /**
   * moonrun `Runtime::new` / `RuntimeConfig::realize_policy`: the inherited restriction
   * transfer (`MOONRUN_INHERITED_POLICY`) intersected with the selected policy file.
   */
  realize(inherited?: Uint8Array): Result<void, PolicyError> {
    return this.#installed(this.#abi.call('policy_realize', inherited));
  }

  /** No policy: unchecked Host Filesystem over the ambient environment. */
  initAmbient(): void {
    this.#abi.call('policy_init_ambient');
  }

  /** What a child receives (the restriction transfer), when a policy is in force. */
  inheritance(): Uint8Array | undefined {
    return this.#abi.call('policy_inheritance') === 0 ? this.#abi.result() : undefined;
  }

  /** The Run's environment (`Env`): the provisioned one under a policy, else the ambient one. */
  env(): EnvPort {
    const abi = this.#abi;
    return {
      get: (key) => (abi.call('env_get', key) === 1 ? abi.resultText() : undefined),
      entries: () => {
        abi.call('env_entries');
        return abi.resultList().flatMap((entry) => {
          const text = utf8(entry);
          const at = text.indexOf('=', 1);
          return at < 0 ? [] : [[text.slice(0, at), text.slice(at + 1)] as const];
        });
      },
      set: (key, value) => {
        abi.call('env_set', key, value);
      },
      unset: (key) => {
        abi.call('env_unset', key);
      },
    };
  }

  // ----- Host Filesystem: `__moonbit_fs_unstable` -----

  #legacy<T>(code: number, value: () => T): FsOutcome<T> {
    return code === 0 ? ok(value()) : err(this.#abi.resultText());
  }

  readFileToString(path: string): FsOutcome<string> {
    return this.#legacy(this.#abi.call('hostfs_read_file_to_string', path), () =>
      this.#abi.resultText(),
    );
  }

  writeStringToFile(path: string, contents: string): FsOutcome<void> {
    return this.#legacy(this.#abi.call('hostfs_write_string_to_file', path, contents), () => {});
  }

  /**
   * `write_bytes_to_file`; `contents` undefined means the guest value was not a byte array,
   * reported (`'not-bytes'`) only after authorization, as upstream decodes it lazily.
   */
  writeBytesToFile(path: string, contents: Uint8Array | undefined): FsOutcome<void> | 'not-bytes' {
    const code = this.#abi.call('hostfs_write_bytes_to_file', path, contents);
    return code === 2 ? 'not-bytes' : this.#legacy(code, () => {});
  }

  createDir(path: string): FsOutcome<void> {
    return this.#legacy(this.#abi.call('hostfs_create_dir', path), () => {});
  }

  readDir(path: string): FsOutcome<string[]> {
    return this.#legacy(this.#abi.call('hostfs_read_dir', path), () =>
      this.#abi.resultList().map(utf8),
    );
  }

  isFile(path: string): boolean {
    return this.#abi.call('hostfs_is_file', path) !== 0;
  }

  isDir(path: string): boolean {
    return this.#abi.call('hostfs_is_dir', path) !== 0;
  }

  removeFile(path: string): FsOutcome<void> {
    return this.#legacy(this.#abi.call('hostfs_remove_file', path), () => {});
  }

  removeDir(path: string): FsOutcome<void> {
    return this.#legacy(this.#abi.call('hostfs_remove_dir', path), () => {});
  }

  pathExists(path: string): boolean {
    return this.#abi.call('hostfs_path_exists', path) !== 0;
  }

  currentDir(): string {
    this.#abi.call('hostfs_current_dir');
    return this.#abi.resultText();
  }

  /** The `*_new` status operations (`0`/`1`/`-1`), with details through the getters. */
  status(
    op:
      | 'read_file_to_bytes'
      | 'create_dir'
      | 'read_dir'
      | 'is_file'
      | 'is_dir'
      | 'remove_file'
      | 'remove_dir',
    path: string,
  ): number {
    return this.#abi.call(`hostfs_${op}_new`, path);
  }

  /** `write_bytes_to_file_new`; `contents` undefined = not a byte array (`conversionError`). */
  writeBytesStatus(
    path: string,
    contents: Uint8Array | undefined,
    conversionError: string,
  ): number {
    return this.#abi.call('hostfs_write_bytes_to_file_new', path, contents, conversionError);
  }

  fileContent(): Uint8Array {
    this.#abi.call('hostfs_file_content');
    return this.#abi.result();
  }

  dirFiles(): string[] {
    this.#abi.call('hostfs_dir_files');
    return this.#abi.resultList().map(utf8);
  }

  errorMessage(): string {
    this.#abi.call('hostfs_error_message');
    return this.#abi.resultText();
  }

  // ----- Host Filesystem authorization of the async Filesystem Jobs -----

  /** moonrun `Job::check_policy`, consulted right before the Job runs. */
  checkJob(payload: FilesystemPayload): AsyncError | undefined {
    const check = (
      kind: number,
      scalars: readonly [number, number, number, number],
      path?: string,
      path2?: string,
      resource?: Resource,
    ): AsyncError | undefined => {
      const [a, b, c, d] = scalars;
      const target = resourcePath(resource);
      return hostError(
        this.#abi.call(
          'policy_check_job',
          kind,
          a,
          b,
          c,
          d,
          path ?? new Uint8Array(0),
          path2 ?? new Uint8Array(0),
          ...(typeof target === 'number' ? [0, target] : [target]),
        ),
      );
    };
    switch (payload.kind) {
      case 'open':
        return check(0, [payload.access, payload.create, 0, payload.request.mask], payload.path);
      case 'fstatx':
        return check(1, [0, 0, 0, payload.request.mask], undefined, undefined, payload.resource);
      case 'file-size':
      case 'file-time':
        return check(1, [1, 0, 0, 0], undefined, undefined, payload.resource);
      case 'statx':
      case 'file-kind-by-path':
        return check(
          2,
          [payload.parent === undefined ? 0 : 1, payload.follow ? 1 : 0, 0, 0],
          payload.path,
          undefined,
          payload.parent,
        );
      case 'file-time-by-path':
        return check(3, [0, payload.follow ? 1 : 0, 0, 0], payload.path);
      case 'realpath':
      case 'inotify-add-watch':
        return check(4, [0, 0, 0, 0], payload.path);
      case 'access':
        return check(5, [payload.access, 0, 0, 0], payload.path);
      case 'chmod':
        return check(6, [0, 0, 0, 0], payload.path);
      case 'flock':
        return check(
          7,
          [payload.exclusive ? 1 : 0, 0, 0, 0],
          undefined,
          undefined,
          payload.resource,
        );
      case 'remove':
        return check(8, [0, 0, 0, 0], payload.path);
      case 'rename':
        return check(9, [0, 0, 0, 0], payload.from, payload.to);
      case 'symlink':
      case 'mkdir':
      case 'rmdir':
        return check(10, [0, 0, 0, 0], payload.path);
      default:
        return undefined;
    }
  }

  /** `HostFs::authorize_read` (TLS key/certificate files, SQLite databases). */
  authorizeRead(path: string): AsyncError | undefined {
    return hostError(this.#abi.call('policy_authorize_read', path));
  }

  /**
   * The HostFs check of a WASI path operation (moon `wasi/mod.rs`): `base` is the
   * directory descriptor's path, `path` the guest path (open, remove) or the resolved
   * host path (the others). The denial line is printed by the component.
   */
  checkWasi(check: WasiCheck): 'allowed' | 'denied' | 'io' {
    const op = (): [number, number, number, string, string, string] => {
      switch (check.kind) {
        case 'open-file':
          return [0, check.read ? 1 : 0, check.write ? 1 : 0, check.base, check.path, ''];
        case 'open-directory':
          return [1, 0, 0, check.base, check.path, ''];
        case 'read-link':
          return [2, 0, 0, '', check.hostPath, ''];
        case 'create-directory':
          return [3, 0, 0, '', check.hostPath, ''];
        case 'rename':
          return [4, 0, 0, '', check.from, check.to];
        case 'remove-at':
          return [5, 0, 0, check.base, check.path, ''];
        case 'read-directory':
          return [6, 0, 0, '', check.hostPath, ''];
      }
    };
    const code = this.#abi.call('policy_check_wasi', ...op());
    return code === 0 ? 'allowed' : code === 1 ? 'denied' : 'io';
  }

  /** `HostFs::authorize_write`. */
  authorizeWrite(path: string): AsyncError | undefined {
    return hostError(this.#abi.call('policy_authorize_write', path));
  }

  /** Admission and SQL authorization are upstream sqlite/policy.rs in the component. */
  sqliteAdmit(filename: Uint8Array, flags: number, vfs: bigint): number {
    return this.#abi.call(
      'policy_sqlite_admit',
      filename,
      flags,
      Number(vfs & 0xffffffffn),
      Number(vfs >> 32n),
    );
  }

  sqliteAuthorize(
    action: number,
    a1: Uint8Array | undefined,
    a2: Uint8Array | undefined,
    db: Uint8Array | undefined,
    trigger: Uint8Array | undefined,
  ): number {
    return this.#abi.call('policy_sqlite_authorize', action, a1, a2, db, trigger);
  }

  // ----- network and process -----

  /** Whether moonrun would check sockets and DNS (a policy is in force). */
  get checksNetwork(): boolean {
    return this.#abi.call('policy_has_net') !== 0;
  }

  /** Whether spawning is checked (moonrun creates `ChildAuthority` only then). */
  get checksProcesses(): boolean {
    return this.#abi.call('policy_has_process') !== 0;
  }

  /** moonrun `HostNetwork::check_*` for a DNS lookup, connect or bind. */
  checkNetwork(request: NetworkRequest): AsyncError | undefined {
    if (request.kind === 'dns') {
      return hostError(this.#abi.call('policy_check_dns', request.host));
    }
    return hostError(
      this.#abi.call(
        'policy_check_socket',
        request.kind === 'connect' ? 0 : 1,
        encodeSockaddr(request.address),
      ),
    );
  }

  /** A getaddrinfo result the guest fetched (moonrun `resolved_connect_rules`). */
  recordResolved(host: string, addresses: readonly Uint8Array[]): void {
    const records = addresses.flatMap((a) => {
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, a.length, true);
      return [len, a];
    });
    const out = new Uint8Array(records.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const r of records) {
      out.set(r, at);
      at += r.length;
    }
    this.#abi.call('policy_record_resolved', host, out);
  }

  /** `ProcessPolicy::allows_unix`; `argv` includes argv[0]. Denials print. */
  checkSpawn(program: string, argv: readonly string[]): AsyncError | undefined {
    return hostError(this.#abi.call('policy_check_spawn', program, nulList(argv)));
  }
}

/** A Resource's `FileGrant` as the component expects it (`abi.rs` `grant`). */
function resourcePath(resource: Resource | undefined): string | number {
  if (resource?.kind === 'stdio') {
    return STDIO;
  }
  if (resource?.kind !== 'file') {
    return UNTRACKED;
  }
  return resource.file.canonicalPath ?? NO_CANONICAL_PATH;
}
