# Wiring the sandbox policy

Reference: moon commit `748b63c`, `crates/moonrun/src` (paths below are relative to it).
The domain in this directory is pure. It decides; it never prints, never touches `node:*`, and
never reads the environment. The ABI/engine layers own the side effects.

## 1. Startup (engine/CLI)

moonrun order (`main.rs:94-120`, `runtime/mod.rs:134-160`):

1. Before argument parsing: `takeInheritedPolicy(process.env)` (host/node/policy-loader.ts). It
   deletes `MOONRUN_INHERITED_POLICY` from the environment first, so `env.from_host = "*"` and
   children never see it. Its failures are *bare* chains (no "failed to load sandbox policy"
   wrapper) and happen before clap's usage errors.
2. An inherited policy wins; `--policy` is then ignored. Otherwise `--policy PATH
   [--policy-source-dir DIR]` is read. No policy means "unrestricted" and is `undefined` everywhere
   below (all `*Authority` constructors take `undefined` and then allow without side effects).
3. `loadRunPolicy({ policyPath, sourceDir })` does 1 and 2 and returns
   `Result<LoadedPolicy | undefined, PolicyError>`. On error print
   `formatErrorChain(error.chain)` and exit 1 (see "CLI notes").
4. With a policy the run's environment is `LoadedPolicy.env` (sorted entries), **not** the ambient
   one: `EnvPort` must be backed by those entries (copy-on-start, then write-through to the owned
   copy only; `process.env` stays untouched, and child processes receive exactly these entries).
   Without a policy the ambient environment is used as today. Environment provisioning is a
   construction-time step; there is no runtime env check.
5. `new FsAuthority({ policy: loaded.policy.fs, canonical, resolve })`,
   `new NetAuthority(loaded.policy.net)`, `loaded.policy.process`, and
   `new ChildAuthority()` only when a policy exists (`process/mod.rs:67-83`: child authority exists
   iff process policy is enforced). `canonical` is any `{realpath}`; `FilePort` already satisfies
   it structurally, but the domain does not import it. `resolve` is `FsPort.resolve`
   (`WorkingDirectory::resolve`).

## 2. Denials

Every `Err(PolicyDenied)` has `code: 'EACCES'` and a `report`. At the moment of denial write
`denialStderr(denied)` (`report + "\n"`, nothing when `report` is undefined) with
`StdioPort.writeStderr`, synchronously and before returning to the guest: moonrun uses `eprintln!`
(`policy/mod.rs:61`), so the line interleaves with guest output exactly where the check ran. Then
return EACCES (`AsyncHostError::PermissionDenied`, errno 13) in the form the family uses.

Texts (all targets are Rust `{:?}` of the lossy string, see `rustDebugStr`):

| Denial | stderr line |
| --- | --- |
| fs read/write | `Sandbox policy blocked file read: "denied/secret.txt"` / `... file write: "denied.bin"`; the target is the path **as the guest wrote it** (relative paths stay relative) |
| unresolvable path, read+write | `... file access: "<target>"` (only when resolution failed and both intents are needed) |
| untracked fd resource | `... file read: "<untracked resource>"` (quotes included) |
| DNS | `Sandbox policy blocked DNS lookup: "host"` (original, un-normalized host) |
| connect/bind | `... network connect: "127.0.0.1:80"` / `"[::1]:443"` / `... network bind: "..."` |
| spawn | `Sandbox policy blocked process spawn` (no colon, no target) |
| pid/handle ownership | nothing printed, EACCES |

## 3. Which family consults what, and when

"Last safe moment" = the instant before the host effect, and for jobs *inside the worker, when the
job executes*, not when `make_*_job` creates it (`async_host/mod.rs:3486-3520`,
`run_policy_checked_job`: check, then `set_err(errno)` on failure and do **not** run the job).

### 3.1 Legacy whole-file imports (`abi/legacy/fs-unstable.ts`, `fs-runtime.ts`, `io.ts`)

`HostFs::ensure_*` (`filesystem/mod.rs:455-468`) wrap the denial as the guest-visible string
`Permission denied: {path}` (`HostFsError::permission_denied`), *in addition to* the stderr line.

| Import | Decision | Order note |
| --- | --- | --- |
| read file/string/bytes, read dir, is_file, is_dir, path_exists, metadata_kind | `authorizeRead(path)` | before touching the path; `is_*`/`exists` return false on denial |
| write file/string/bytes, create_dir | `authorizeOpen(path, 1, 1, false)` (write intent) | authorize **before** decoding the guest byte array, so denial beats an invalid-value error (`filesystem/mod.rs:144-150`) |
| remove_file, remove_dir | `authorizeRemove(path)` | entry semantics |
| current_dir | `authorizeRead(".")`, empty string on denial | `mod.rs:200` |

### 3.2 Async filesystem jobs (`kernel/fs-jobs.ts`, `abi/async/fs.ts`)

Checked in the worker immediately before execution (`filesystem/job/mod.rs:423-473`):

| Job | Decision |
| --- | --- |
| open | `authorizeOpen(filename, access, createMode, append)`; **then**, if the stat request mask has anything beyond the open-identity bits (`STAT_OPEN_IDENTITY`: dev+ino), `authorizeRead(filename)` as well |
| fstatx, file_size, file_time (fd) | `authorizeResourceMetadata(resource.canonicalPath)`; no fd -> EBADF first |
| statx / file_kind_by_path | `parent` absent: follow -> `authorizeRead(path)`, nofollow -> `authorizeEntryMetadata(path)`; `parent` present: `authorizeMetadataAt(parent.canonicalPath, path, follow)` |
| file_time_by_path | follow -> `authorizeRead`, nofollow -> `authorizeEntryMetadata` (no parent) |
| realpath, inotify add_watch | `authorizeRead(path)` |
| access | `authorizeAccess(path, mode)` (mode 2 = write, else read) |
| chmod | `authorizeWrite(path)` |
| flock | no fd -> EBADF; `authorizeResourceLock(canonicalPath, exclusive)` (shared lock needs nothing) |
| remove (unlink) | `authorizeRemove(path)` |
| rename | `authorizeRename(old, new)` (old first, stops at first denial) |
| symlink, mkdir, rmdir | `authorizeWriteEntry(path)` |
| read, write, fsync, readdir | nothing (the fd was authorized at open) |

Resource provenance: a file opened by an open job records `canonicalPath = realpath(filename)`
(`runner.rs:63`, `std::fs::canonicalize(filename).ok()`, so `undefined` when it fails). Directory fds
used as `parent` need the same. Files opened any other way (pipes, stdio, sockets) have no
canonical path and are denied by the metadata/lock checks.

Other fs consumers:

* TLS `set_server_files` (`async_host/mod.rs:3818-3830`): for the private key then the
  certificate, `authorizeRead(file)`; on denial the TLS handle gets the error string
  `failed to access TLS private key file: PermissionDenied` / `failed to access TLS certificate
  file: PermissionDenied` (`{error:?}` of the error enum) *before* the backend loads the file.
* SQLite open (`sqlite/policy.rs:34-70`): unless `:memory:`: `authorizeRead(db)`,
  `authorizeRead(parent or ".")`, and if flags include READWRITE|CREATE `authorizeWrite(parent)`.
  Any denial -> `SQLITE_CANTOPEN` (the stderr line is still printed). Path text is the guest string.

### 3.3 Network (`abi/async/` socket + getaddrinfo families)

`network/mod.rs`; decode the guest `sockaddr` first (short buffer -> EFAULT, unknown family ->
EINVAL, as moonrun does *before* policy), then call with `{ip, port}`.

| Operation | Moment | Decision |
| --- | --- | --- |
| `make_getaddrinfo_job(host)` | job creation | `net.authorizeDns(host)` |
| `getaddrinfo_result` | when the guest fetches the result, only after success | `net.recordResolved(host, addresses)` (never denies; extends the run-lifetime resolved list) |
| connect (tcp), `connect_udp`, `send_to` | immediately before the host call | `net.authorizeConnect(addr)` |
| `bind` and `make_bind_job` | immediately before | `net.authorizeBind(addr)` |
| `listen` | **implicit bind**: `getsockname`; if the port is 0 (or getsockname fails, using the family's wildcard) check `authorizeBind(thatAddr)` before listening | an unbound `listen` is the `policy/listen-implicit-bind-denied` case |
| accept, recv_from, read/write | nothing | |

`recordResolved` is the only mutable policy state in the network domain; keep one `NetAuthority`
per run.

### 3.4 Process (`abi/async/` process family, `kernel` spawn/wait jobs)

`process/job/mod.rs:383-399`, `process/mod.rs:255-300`:

| Step | Decision |
| --- | --- |
| spawn job, in the worker before spawning | `authorizeSpawn(policy.process, programPath, argv)` (argv includes argv[0]). Denied -> job err EACCES, nothing spawned |
| spawn job success | `child.trackSpawned(pid)`; if the guest never claims the result as a process handle, `child.revokeUnclaimed(pid)` (`async_host/mod.rs:1249`) |
| process handle creation (`open_pid_handle` etc.) | `child.checkOwned(pid)` then `child.trackHandle(handle, pid)` |
| handle close | `child.untrackHandle(handle)` |
| `make_wait_for_process_job(handle, pid)` | `trackedPid = child.handlePid(handle)` (unless the handle is the invalid fd -> none) |
| wait job, at execution | `child.checkWait(hasHandle, trackedPid, pid)`; on success after the real wait, `child.finishWait(pid)` (reap is deferred until after the check) |
| kill / signal / other pid operations | `child.checkOwned(pid)` (`with_owned_child_pid`) |
| explicit finish with handle | `child.checkFinish(pid, handle)` then operate then `child.finishWait(pid)` |

With no policy there is no `ChildAuthority`: all pid operations are unchecked.

Policy inheritance to children (`process/job/mod.rs:243-290`, `process/ambient.rs:136-200`):
only when `isMoonxExecutable(programPath)`, and only under a policy. The spawn job creates an
anonymous file containing `policy.inheritance` (`openPolicyTransfer(payload)` in
host/node/policy-loader.ts: created, unlinked, positional write so the offset stays at 0), passes
it as an extra descriptor and sets `MOONRUN_INHERITED_POLICY=<fd number in the child>` in the child
environment (overwriting a same-named entry from the guest). In Node pass the fd as an additional
`stdio` slot (index >= 3) and use that index; close the parent's copy after the spawn call. If
creating the file fails, the spawn fails with that errno before any process exists. A real moonrun
child reads the descriptor to the end (`read_to_end`), so the file must be positioned at 0.
The payload format is the same JSON a real moonrun writes, so a moonrun-js parent can drive a real
moonrun/moonx child and vice versa. Roots in the payload are canonical absolute paths.

### 3.5 Not covered

WASI (`wasi_snapshot_preview1`) is intentionally outside the policy (`--help`: "WASI is not
covered"); do not consult any authority there. The `moonbitlang/core` stdout/time/random/env
imports are not policy-gated either, apart from env provisioning.

## 4. CLI notes

* `formatErrorChain` in `hosts/node/cli.ts` prints anyhow's `{:?}`. One difference to fix when
  wiring: anyhow indents the *final empty line* of a multi-line cause (the TOML errors end with
  `\n`), producing a line consisting only of the cause indent (7 spaces after `1: `/`0: `, 4 for a
  single cause). `indent()` currently leaves empty lines empty. `test/unit/policy-diff.test.ts`
  has an exact reference formatter.
* The context strings are `FILE_CONTEXT` / `INHERITED_CONTEXT` already included in
  `PolicyError.chain[0]` for file/inherited loads, so print the chain as is. Failures of
  `takeInheritedPolicy` are bare.
* `--policy-source-dir` (hidden, requires `--policy`) is passed as `sourceDir`.
* Policy loading happens when the run is constructed, after the module has been loaded
  (moonrun: `Runtime::new` inside `run`), so wasm load errors still win over policy errors; but
  inherited-policy descriptor errors happen before clap parsing.

## 5. Known divergences / unmatched

* TOML syntax errors: the common toml_edit messages are reproduced with identical excerpts
  (see the diff test corpus); rarer ones (exotic number/date forms, multi-line string edge cases,
  out-of-order table definitions) may differ in wording or caret width. Valid files are
  accepted by the same grammar; `0x` style integers and datetimes parse but datetimes are always
  "invalid type: map" like the toml crate.
* YAML (`.mbtx` front matter) is a subset reader (block maps/sequences, flow collections, plain and
  quoted scalars); serde_yaml's error wording is not reproduced (`msg at line L column C`).
* serde_json float display for huge/odd literals uses JS correct rounding; serde_json (without
  `float_roundtrip`) can differ in the last digit.
* Non-UTF-8 policy files are rejected with `stream did not contain valid UTF-8`; non-UTF-8 path
  names and env values cannot be represented (the ports are string based).
* Sorting of environment names is by code point (Rust byte order) and not UTF-16 order.
