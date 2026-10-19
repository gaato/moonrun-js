# Wiring the sandbox policy

Reference: moon at the `upstream/moon` pin, `crates/moonrun/src` (paths below are relative to it).
The decisions, the error texts and the denial lines are upstream's own code: `PolicyComponent`
(component.ts) wraps the moonrun-policy wasm (crates/moonrun-policy: `policy/**`,
`runtime/environment*.rs`, `runtime/working_directory.rs`, `filesystem/mod.rs`). One instance
serves one Run. The component reaches the OS only through the capabilities it is built with
(`abi/os-capabilities.ts` over the run's ports), and prints `Sandbox policy blocked …` itself,
synchronously, through the run's stderr port (moonrun's `eprintln!`, `policy/mod.rs:54-61`).
What remains here is *where* each check is consulted.

## 1. Startup (hosts/node/cli.ts, engine/run.ts)

moonrun order (`main.rs:94-120`, `runtime/mod.rs:134-160`):

1. Before argument parsing: `takeInheritedPolicy(process.env)` (hosts/node/policy-loader.ts,
   the OS half of `moonutil::policy_transport`). It deletes `MOONRUN_INHERITED_POLICY` first, so
   `env.from_host = "*"` and children never see it. Its failures are bare chains.
2. clap parses the command line (moonrun-cli). The module is compiled (its errors win).
3. An inherited policy wins and `--policy` is ignored: `policy.loadInherited(bytes)`, else
   `policy.loadFile(path, sourceDir)`. Failures are anyhow chains with runtime/mod.rs's context
   first; print with `formatErrorChain` and exit 1. No policy means unrestricted.
4. `run(loaded, host, { policy })`: with an enforced policy the run's `EnvPort` is
   `policy.env()` (the provisioned `Env`; children get exactly these entries), and the Async Host
   gets `authorizeFilesystem` / `authorizeNetwork` / `recordResolved` (abi/async `PolicySeams`).
   Without one, the legacy filesystem imports instantiate an unchecked component on first use
   (`ctx.policy()`, Host Filesystem over the ambient `Env`).

## 2. Denials

Every denial is `EACCES` (`AsyncHostError::PermissionDenied`) in the form the family uses; the
stderr line was already written by the component. Untracked resources read
`"<untracked resource>"`; `ChildAuthority` denials print nothing.

## 3. Which family consults what, and when

"Last safe moment" = the instant before the host effect; for Jobs, inside the worker when the
Job executes (`run_policy_checked_job`): check, then `fail(error)` and do not run the Job.

### 3.1 Legacy whole-file imports (`abi/legacy/fs-unstable.ts`)

All operations are the component's Host Filesystem (`HostFs` methods) and `Env`
(`filesystem/v8/runtime.rs`). The adapter only converts guest values: `write_bytes_to_file*`
pass `undefined` for a non-`Uint8Array` so that the component decodes after authorization
(`filesystem/mod.rs:144-150`): denial beats the invalid value.

### 3.2 Async filesystem Jobs (`kernel/fs-jobs.ts` via `authorizeFilesystem`)

`policy.checkJob(payload)` is upstream `Job::check_policy` (`filesystem/job/mod.rs:423-473`),
mirrored by the component's `filesystem/job` stub over `HostFs`'s private checks. fd-based Jobs
use `HostFile.canonicalPath`, the best-effort `realpath` taken right after the open (upstream
`std::fs::canonicalize(filename).ok()` in the open Job); a handle that is not a file is EBADF.

Other filesystem consumers:

* TLS `set_server_files` (`async_host/mod.rs:3818-3830`): `policy.authorizeRead(file)` for the
  private key, then the certificate; on denial the TLS handle gets `failed to access TLS private
  key file: PermissionDenied` / `... certificate file: PermissionDenied` before the backend loads
  the file (`TlsDomainDeps.authorizeRead`).
* SQLite open (`sqlite/policy.rs`, to be added to the component): unless `:memory:`, read checks
  on the database and its parent, a write check on the parent for READWRITE|CREATE; any denial is
  `SQLITE_CANTOPEN`.

### 3.3 Network (`kernel/network.ts` via `authorizeNetwork` / `recordResolved`)

`network/mod.rs`: the kernel decodes the guest `sockaddr` first (short buffer -> EFAULT, unknown
family -> EINVAL, before policy), then asks `policy.checkNetwork({kind, address|host})`:
DNS at `make_getaddrinfo_job`, connect / `connect_udp` / `send_to` and bind / `make_bind_job`
right before the host call, and `listen`'s implicit bind. After a successful getaddrinfo result
is fetched, `policy.recordResolved(host, addresses)` extends the run's resolved connect rules.

### 3.4 Process (`abi/async/` process family, `kernel` spawn/wait jobs)

`process/job/mod.rs:383-399`, `process/mod.rs:255-300`:

| Step | Decision |
| --- | --- |
| spawn job, in the worker before spawning | `policy.checkSpawn(programPath, argv)` (argv includes argv[0]; prints the denial). Denied -> job err EACCES, nothing spawned |
| spawn job success | `child.trackSpawned(pid)` (`ChildAuthority`, child-authority.ts, exists only when `policy.checksProcesses`); if the guest never claims the result as a process handle, `child.revokeUnclaimed(pid)` (`async_host/mod.rs:1249`) |
| process handle creation (`open_pid_handle` etc.) | `child.checkOwned(pid)` then `child.trackHandle(handle, pid)` |
| handle close | `child.untrackHandle(handle)` |
| `make_wait_for_process_job(handle, pid)` | `trackedPid = child.handlePid(handle)` (unless the handle is the invalid fd -> none) |
| wait job, at execution | `child.checkWait(hasHandle, trackedPid, pid)`; on success after the real wait, `child.finishWait(pid)` (reap is deferred until after the check) |
| kill / signal / other pid operations | `child.checkOwned(pid)` (`with_owned_child_pid`) |
| explicit finish with handle | `child.checkFinish(pid, handle)` then operate then `child.finishWait(pid)` |

With no policy there is no `ChildAuthority`: all pid operations are unchecked.

Policy inheritance to children (`process/job/mod.rs:243-290`, `process/ambient.rs:136-200`):
only when `isMoonxExecutable(programPath)`, and only under a policy. The spawn job creates an
anonymous file containing `policy.inheritance()` (`openPolicyTransfer(payload)` in
hosts/node/policy-loader.ts: created, unlinked, positional write so the offset stays at 0), passes
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

* `formatErrorChain` in `hosts/node/cli.ts` prints anyhow's `{:?}` (every line of a multi-line
  cause indented, including a trailing empty one).
* `--policy-source-dir` (hidden, requires `--policy`) is passed as `sourceDir`.
* Policy loading happens after the module has been compiled, so wasm load errors still win; the
  inherited-policy descriptor is read before clap parses.
