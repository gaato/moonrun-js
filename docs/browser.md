# Browser host and local demo

From a checkout with dependencies installed, one command builds and starts the demo:

```fish
mise exec -- pnpm demo:browser
```

Open the printed `http://127.0.0.1:8080/?token=…` URL in Chrome with JSPI enabled in
its engine. Select a `.wasm` or paste a CORS-enabled URL, enter arguments as a JSON
array (without the CLI `--` separator), then Run. stdout/stderr stream separately;
the status shows the `RunOutcome` and exit code. The demo uses finite UTF-8 stdin. Extra
files are preloaded under `/work`. Each Run creates and terminates a dedicated module
Worker, with fresh environment, DNS mappings and memory filesystem; external mounts can
persist independently. Reload to stop a guest
that never finishes. Streaming stdin is available to embedders; the demo has no terminal or persistent filesystem UI.

For an already built checkout:

```fish
mise exec -- node scripts/browser-demo.ts --port 8080 --allow api.github.com:443
```

The relay and page bind only to `127.0.0.1`. Defaults allow **example.com:443**,
**discord.com:443**, and **kbbi.kemendikdasmen.go.id:443**. `--allow HOST:PORT` adds
an exact destination (including literal IPs; IPv6 is written `::1:PORT`). Redirects
need their destination separately allowed. No wildcard, arbitrary-port or LAN-wide
proxy mode is provided. `ws` and its types are development dependencies only; the
relay script and demo are not included in the npm package.

The HTTP Host header must match the bound address, browser Origin must be same-origin,
and `/relay` and `/roots` require the unpredictable per-server URL token. Missing Origin
is accepted for token-bearing non-browser clients (also used by tests). HTTP serves
only the demo and built JS/wasm, follows real paths before checking scope, and sends no
CORS permission headers. Serve the page from this loopback origin; connecting a public
website to this companion service is outside this demo's scope. Ctrl-C closes HTTP,
WebSockets and all outgoing TCP sockets.

## Embedding

```ts
import { runInWorker } from 'moonrun-js/browser';

const result = await runInWorker({
  wasm: new Uint8Array(await file.arrayBuffer()),
  args: ['--help'],
  env: {},
  files: { 'input.txt': 'hello\n', empty: null },
  stdin: new Uint8Array(),
  stdout: (chunk) => consumeStdoutBytes(chunk),
  stderr: (chunk) => consumeStderrBytes(chunk),
  // Optional: WebSocket URL for a compatible relay, with its token query.
  relay: relayUrl,
});
```

Serve **all of `dist/browser/`**, including `worker.js`, shared JS chunks and the four
wasm components. The browser entry bundles its JS dependencies; it needs no import map
or Node shims. Workers and component URLs resolve relative to their emitted modules.
A bundler used by an embedder must preserve/copy these assets and the module Worker.

`createBrowserHost(options)` is the lower-level API. It asynchronously fetches and
compiles moonrun-diag, moonrun-policy, tls-engine and sqlite-engine, then returns a Host
with synchronous cached component ports and a `diagnostics` instance for `compileBytes`.
The Node CLI parser component is unnecessary. Run/guest compilation belongs in a Worker;
Chrome restricts large synchronous module compilation on the main thread. Use
`host.run(bytesOrModule, {name, args})` for the browser Run's lifecycle checks.

Host options additionally allow a synchronous stdin byte-source callback, `BrowserStdin`,
cwd, and explicit DER `roots`. Output callbacks receive owned byte copies. `runInWorker`
keeps callbacks on the main thread and sends cloneable messages to the Worker. Its return
value remains an awaitable Promise of the existing `RunOutcome`, with file/input/signal methods
as described below; it terminates the Worker on outcomes and Worker errors.
Output-callback errors and failure to clone the initial run request reject its Promise
after termination.

With a relay, Host preparation fetches `/roots` using the same token query: a JSON array
of base64 DER certificates from the relay machine's existing `nodeTrustStore` adapter
(including its documented Node fallback, D24). An explicit `roots` array overrides this.
Without a relay or explicit roots the system-root list is empty. TLS verification is
never disabled. These are **not the browser's roots** (D44).

## Live memory filesystem

`runInWorker` returns a handle with `fs`; `createBrowserHost` exposes the same facade as
`host.memoryFs`. The latter name leaves `host.fs` available as the existing synchronous
core port. The exported `BrowserMemoryFs` interface has six async methods:

```ts
writeFile(path: string, data: Uint8Array | string): Promise<void>
readFile(path: string): Promise<Uint8Array>
readdir(path: string): Promise<BrowserMemoryEntry[]>
stat(path: string): Promise<BrowserMemoryStat>
mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
remove(path: string, options?: { recursive?: boolean }): Promise<void>
```

`BrowserMemoryEntry` is `{name, kind}`, using the existing `FileKind` values `file`, `dir`,
`symlink` and `other`. `BrowserMemoryStat` is `{kind, size, mtimeMs}` with numeric byte
size and millisecond mtime; stat follows symlinks. The facade covers the run's **memory
VFS only**, shared live with the guest and all wasm children, without a separate mount.

```ts
// `running` is an interactive shell handle; filesystem execution needs execPaths enabled.
await running.fs.writeFile('/work/uploads/input.txt', 'hello\n');
await running.fs.writeFile('/work/prog.wasm', programBytes);
await running.write(new TextEncoder().encode('cat uploads/input.txt; ./prog.wasm\n'));
// After a guest command has finished writing an output file:
const output = await running.fs.readFile('/work/out.txt');
const entries = await running.fs.readdir('/work');
await running.fs.mkdir('/work/scratch/deep', { recursive: true });
await running.fs.remove('/work/scratch', { recursive: true });
```

Every path must be absolute. writeFile accepts UTF-8 strings or copied byte arrays,
creates missing parents and installs a fresh regular-file inode with permissions 0666
and current mtime. Existing descriptors retain their old inode, bytes and offset, like
unlink followed by create; writes through an old descriptor do not alter the replacement.
Final symlinks are rejected by writeFile (ELOOP); directories cannot be replaced (EISDIR).
The ordinary 64 MiB memory-file limit applies. readFile returns an owned byte copy.

mkdir defaults to nonrecursive creation: missing parents give ENOENT and existing entries
EEXIST. Recursive mkdir accepts an existing directory and creates missing parents.
remove deletes a file, symlink or empty directory; nonempty directories give ENOTEMPTY.
Recursive remove deletes a tree without following contained symlinks. `/` cannot be
removed (EBUSY). There is no batch API or implicit null/deletion value for writeFile.

Memory parent symlinks are followed. Any path traversing a mount, including through a
symlink or before a `..`, is rejected with EROFS without calling its provider. Recursive
removal also rejects a memory tree containing actual mount points before deleting any
entries. Parent listings can show synthetic mount-point names. Update mounted storage
through its provider instead. A removable memory symlink is unlinked rather than deleting
its target; a final symlink resolving into a mount is rejected too.

Errors reject with an ordinary `Error` carrying a `code` from `HostError` (for example
ENOENT, ENOTDIR, EISDIR, ENOTEMPTY, EEXIST or EINVAL). Relative paths give EINVAL.
Failed calls do not end the Run. Parent directories created before a write failure may
remain; operations do not provide rollback.

Worker calls made during component preparation are queued. Each Promise resolves after
its operation is applied, so await writeFile before issuing a guest command that uses it.
All facade operations execute synchronously in the Worker's single JS thread and are
serialized with guest filesystem accesses: completed guest writes are visible to the
next facade read, and completed facade writes to the guest's next access, through both
sync and async memory ports. There is no transaction across multiple calls; an already
pending guest job may run before or after a facade request. A guest blocking the Worker's
event loop delays messages and acknowledgments.

**Lifetime choice:** the Worker still terminates when the Run finishes. All subsequent
filesystem calls, including reads, reject with `code: 'EBADF'` / `Run has ended`; pending
unacknowledged calls reject too. Read output files before exiting an interactive guest.
`host.memoryFs` is available before and during `host.run`, and uses the same closed-state
checks after `host.run` ends. No extra Worker lifetime or disposal API is introduced.

## Asynchronous filesystem mounts

Both `runInWorker` and `createBrowserHost` accept `mounts: Record<string, MountProvider>`.
Mount keys are absolute guest paths. Resolution uses the longest path-component prefix;
`/mnt/local` does not match `/mnt/locality`. Mounts and their parent directories appear
in directory listings. Nested mounts shadow the enclosing provider at their mount point.
Everything else stays in the existing memory VFS; cwd must exist and be a directory.
The VFS and mounts are shared with wasm children, with separate cwd views and shared
open-file offsets for duplicated descriptors.

```ts
import { directoryHandleProvider, runInWorker } from 'moonrun-js/browser';

// In a user-gesture handler, before starting the Worker:
const picked = await window.showDirectoryPicker({ mode: 'readwrite' });
const opfs = await navigator.storage.getDirectory();
const running = runInWorker({
  wasm: programBytes,
  mounts: {
    '/mnt/local': directoryHandleProvider(picked),
    '/mnt/opfs': directoryHandleProvider(opfs),
    '/mooncakes': customProvider,
  },
  stdout: consumeStdoutBytes,
  stderr: consumeStderrBytes,
});
```

**One threading model:** providers passed to `runInWorker` stay on the main thread.
Only operation requests, Result values and byte ranges cross `postMessage`; callback
functions and native directory handles are never cloned. Open readers get private RPC
ids and are released when their last descriptor closes or the Worker finishes. Late
opens after termination are released too. This keeps permission-bearing handles and an
embedder's fetch/cache state together and gives every provider the same contract.
For `createBrowserHost`, provider functions execute in the caller's realm: call it inside
your own Worker if you want providers to run there instead. Guest execution and component
compilation still belong in a dedicated Worker.

The exported `MountProvider` needs just three async functions. Paths are absolute **within
that provider**, with `/` as its root; they never contain the guest's mount prefix.
Each function returns `{ok: true, value}` or `{ok: false, error: {code}}` using the existing
`HostError` codes. Rejected promises become EIO; intentional failures should return a
Result. Providers own their fetching and caching policy.

| Function | Successful value |
|---|---|
| `stat(path)` | `{kind, size?, mtimeMs?, mode?}`; file size is required; directory size defaults to 0 |
| `readdir(path)` | array of `{name, kind}`, without `.` or `..`; names are single path components |
| `open(path)` | `{size, read(offset, length), close?}`; read returns a Result of bytes, close is synchronous cleanup |

Kinds are `file`, `dir`, `symlink` or `other`. Reads may return fewer bytes than requested;
an empty range means EOF. Range reads do not require loading a whole file. Optional
`readlink(path)` returns its target string; guest-namespace symlinks are followed with
the same 40-link bound, including links across mounts. Mount points are synthetic
directories. Provider file metadata maps to Linux stat: stable inode per guest path per
run, synthetic device/uid/gid, file modes 0444 or 0644, directory modes 0555 or 0755 based
on write capabilities, mtime in milliseconds (default 0). `mode` overrides permission
bits, while `kind` supplies the type bits. Other timestamps are synthetic.

Optional write capabilities are `create(path)`, `write(path, offset, bytes)` (byte count),
`truncate(path, size)`, `mkdir(path)`, `remove(path)` (file or empty directory), and
`rename(from, to)`; the others return `void` inside the successful Result. Missing
capabilities fail with EROFS. Cross-mount rename is EXDEV; removing/renaming mount points
is EBUSY. Open/truncate and async reads/writes/stat/statx/fstatx/readdir/access/realpath
use the existing async filesystem jobs. Issued fs jobs remain non-abortable: cancellation
waits for completion (compat cancel returns 0), including provider writes. Provider calls
already issued when a Worker is terminated may still complete on the main thread.
Writes commit before their returned Promise resolves; fsync waits for queued descriptor
writes and adds no provider-specific durability guarantee. chmod, symlink creation and
watching mounted paths are unsupported (EROFS/ENOSYS).

The VFS normally caches metadata, directory listings and fetched byte ranges for the
run; byte caching is capped at 64 MiB total, independently of file size. Mutations made
through this VFS invalidate affected cached paths. Set `cache: false` on a provider to
disable these caches and observe outside changes on subsequent async operations. Open
readers should then obtain current bytes on each range read. There is no coherent snapshot
or cross-tab transaction guarantee. Foreign open-file behavior after outside rename or
unlink is provider-dependent; mounted descriptors are path-backed, not native POSIX fds.

**Synchronous limitation:** legacy `__moonbit_fs_unstable` and WASI imports cannot await
a provider. They can use metadata/listings/ranges already cached by earlier async access;
uncached data returns EAGAIN at the port. WASI maps that to AGAIN (6); legacy reads use
their existing panic/SIGABRT behavior (`Failed to read file: …`). Whole-file reads need
the complete file cached, so files exceeding the byte-cache budget remain async-only.
With `cache: false`, provider content remains async-only. Mount points and their parent
directories are always visible. Synchronous writes and truncate on mounts return EROFS
even for a writable provider; they cannot safely persist changes asynchronously.

`directoryHandleProvider(handle, {readOnly?, cache?})` ships with the browser entry.
It works with picked folders and OPFS, defaults to read/write and `cache: false`, and
uses `File.slice()` for range reads. Grant permissions on the main thread before use;
the helper does not request permission or show a picker. Permission failures are EACCES,
quota failures ENOSPC, missing entries ENOENT, and type mismatches ENOTDIR/EISDIR.
Writes serialize through `createWritable({keepExistingData: true})` and close before
reporting success, preserving unwritten bytes; errors abort the temporary stream.
[createWritable changes become visible on close](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable).
Rename uses native `move()` only when available and otherwise returns ENOSYS, with no
copy/delete emulation: [availability is limited, especially outside OPFS and for directories](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#renaming-and-moving-files-and-folders).
There are no symlinks, POSIX ownership/permission bits, OS locks or file watches in this
provider. Exclusive create is a stat-then-create check, not an atomic OS operation.
The demo does not add folder-picker UI; these are embedding APIs.

## Wasm child commands and streaming input

These are optional **browser extensions**, not native moonrun process behavior (D45–D46).
No command registry, package resolver, network fetcher or application UI is included.

```ts
const running = runInWorker({
  wasm: shellBytes,
  name: 'sh',
  args: ['-i'],
  stdin: 'stream',
  // Executed on the main thread after a filesystem PATH miss.
  resolveCommand: async (program, args, { cwd, env }) =>
    resolveProvidedWasm(program, args, { cwd, env }),
  stdout: consumeStdoutBytes,
  stderr: consumeStderrBytes,
});
await running.write(new TextEncoder().encode('echo hello | tr a-z A-Z\n'));
// Later, when input is finished:
running.end();
const outcome = await running;
```

`resolveCommand(program, args, {cwd, env})` returns `Promise<ResolvedCommand | undefined>`.
The exported result type preserves raw bytes and compiled Modules and also accepts an
interpreter-style command object:

```ts
type ResolvedCommand = Uint8Array | WebAssembly.Module | {
  wasm: Uint8Array | WebAssembly.Module;
  args?: readonly string[];
  argv0?: string;
};
```

Object `args` replaces the arguments **after argv[0]**; `[]` removes them all. `argv0`
replaces the original name visible to the child (and names its Run for diagnostics).
Omitted fields keep the spawn arguments and original argv[0] (or program name if absent).
An explicit empty argv0 is preserved. Like a `#!` interpreter or binfmt handler, a resolver
can consume its own dispatch arguments before starting the resolved wasm:

```ts
resolveCommand: async (program, args, context) => {
  if (program === 'moonx') {
    const [coordinate, ...guestArgs] = args;
    if (coordinate === undefined) return undefined;
    const wasm = await loadProvidedCommand(coordinate, context);
    return wasm === undefined ? undefined : { wasm, args: guestArgs, argv0: coordinate };
  }
  return resolveOtherProvidedCommand(program, args, context);
}
```

For example, `moonx gaato/kbbi/cmd/kbbi@0.1.6 rumah` can run kbbi with only `rumah` as
its argument. Resolution/loading policy still belongs to the embedder. Rewriting applies
only to resolver results; PATH and direct execPaths file hits retain their original argv.
The rest of the spawn request (cwd, environment, stdio, pid and wait/kill behavior) is
unchanged, and nested commands can use the same return shapes. Objects and Modules are
relayed from the main thread when using `runInWorker`.

`program` is exactly the guest's request, `args`
excludes argv[0], cwd is an existing absolute directory, and env is the child's complete
snapshot (first repeated key wins). The callback supplies fallback catalog/loading policy;
the Host includes no command catalog or network fetcher. `undefined` gives ENOENT after
a complete filesystem miss (candidate errors are preserved as described below); cli/sh prints
`sh: OSError("@process.run(): No such file or directory")` and sets status 127, exactly
as with a missing native command. A callback rejection gives EIO. If passing a Module,
the embedder should compile with MoonBit's js-string builtins/options when needed;
bytes go through the existing compatibility compiler.

**Executing files:** `execPaths` defaults to `true` when a resolver or at least one mount
is configured, and `false` otherwise. Set `execPaths: true` to enable it for a memory-only
filesystem without a resolver. This single switch enables both direct paths and PATH
search. With this enabled, a program containing `/` bypasses the
resolver and loads from the run's filesystem: `./prog.wasm` is relative to the **spawn
cwd**, while `/mnt/local/prog.wasm` is absolute. Symlinks follow the ordinary filesystem
rules. Async stat/open/read support uncached mounts, including main-thread providers;
the complete executable is read before creating the child. It must be a readable regular
file starting with `\0asm`. Executable permission bits are not required; native binaries
and shebang scripts are not supported. The existing compiler validates the remaining
wasm, and a compile failure follows the child exit-1 mapping below.

For a name **without `/`**, resolution is:

1. Search directories in the **child spawn environment's PATH**, left to right, in the
   memory VFS and mounts. If PATH is unset, use `/usr/local/bin:/usr/bin:/bin`. An empty
   PATH is a single current-directory component; leading, trailing or repeated colons
   also represent the spawn cwd. Relative directories resolve against that cwd.
2. Run the first regular file starting with the wasm magic. Skip missing paths, ENOTDIR,
   non-wasm files and non-regular files, remembering format/permission errors. Search uses
   the same async stat/open/read ports as direct paths, with no separate command cache;
   later lookups observe VFS writes under the provider's ordinary caching policy.
3. If no candidate matches, call `resolveCommand` with the original bare name, args,
   cwd and child environment. A returned command wins over remembered candidate errors.
   If absent or `undefined`, return EACCES if any candidate was denied/non-regular,
   otherwise ENOEXEC if any candidate was non-wasm, otherwise ENOENT. Other filesystem
   errors stop lookup immediately; a resolver rejection remains EIO.

The filesystem-PATH-first order follows [POSIX execvp](https://pubs.opengroup.org/onlinepubs/9799919799/functions/exec.html)
and [Wasmer WASIX's PATH-enabled spawn](https://github.com/wasmerio/wasmer/blob/main/lib/wasix/src/syscalls/wasix/proc_spawn3.rs);
the embedder resolver fallback is a moonrun-js extension. Skipping non-wasm formats is
also a browser policy: real moonrun stops at ENOEXEC even if a later native executable
exists, while POSIX execvp can hand such a file to a shell. We do not execute native
formats or shebang scripts. Real moonrun does continue after EACCES and remembers it
when no candidate succeeds, as here.

cli/sh 0.2.1 passes bare names unchanged to `@process.run()`; PATH lookup happens in this
Host, not in cli/sh. `command -v` and `which` are not builtins in that shell: it attempts
external commands named `command` and `which`. Embedders can supply these through PATH
or the resolver if needed.

Missing files give ENOENT, non-wasm files give ENOEXEC (`Exec format error`), and directories
or other non-regular files give EACCES (`Permission denied`). Other filesystem failures
propagate their error code. Like real moonrun, cli/sh 0.2.1 prints an `@process.run()`
OSError and sets `$?` to **127 for all these spawn failures**, including ENOEXEC/EACCES.
There is no resolver fallback after a failed **slash-containing** path lookup.
Setting `execPaths: false` disables filesystem execution, including PATH search, and restores
resolver ownership of **all** command names, including ones with `/`.

Without a resolver, enabled filesystem execution still supports bare names on PATH;
an unsuccessful search returns the errors above. With neither a resolver nor enabled
filesystem execution, all spawn/kill operations return ENOSYS as before. Policy transfers
always remain unsupported (ENOSYS).

Resolved commands execute as separate Runs **inside the same Worker**. Each gets its
spawn argv[0], args, environment, cwd view, diagnostics and kernel state; inodes and
open-file descriptions are shared through the memory VFS. Duplicated file descriptors
share offsets and survive parent closure. Components and trust roots are reused.
Nested children use the same resolver and path-execution setting. Pids increase from 1 within each Worker and
are synthetic; no OS processes are created.

The existing kernel owns spawn/wait jobs, pid handles, cancellation, pipe readiness and
Linux-style error conversion. Child async stdout/stderr use ordinary kernel pipes and
the existing `feedChild` / `drainChild` bridges; a full pipe blocks the producer, and a
closed reader gives EPIPE. Merged stdout/stderr share a pipe and preserve write order.
Legacy/WASI output imports may also suspend for host-pipe backpressure. Guest wasm
start sections cannot suspend (ordinary `_start` exports can). File redirection and
inherited stdio work without exposing another Run's kernel handles. Extra inherited
fds/policy transfers remain unsupported; this is not an OS process sandbox or a complete
POSIX process environment.

| Child outcome | Process result |
|---|---|
| completed | exit 0 |
| exited | low 8 bits of exit code |
| guest trap, host/compile failure | exit 1 (matching the Node CLI) |
| moonrun panic/leak outcome | exit 101 |
| signaled | the signal number; the existing kernel reports its negation |

The kernel's process result is an exit code or negative signal, as in moonrun's process
API, rather than a raw packed `waitpid` word. Output is drained before publishing normal
child exit; forced termination may discard pending output. The top Run owns the Worker
process tree: when it finishes, remaining wasm children are stopped and a late resolver
result or file load cannot create an orphan Run. Detached/background lifetimes across top Runs are
not supported.

`write(bytes)` copies its input and returns a Promise for input capacity. Await it for
backpressure; messages are serialized in chunks of at most 64 KiB. It is usable while
components are loading. `end()` follows previously queued writes and delivers EOF.
With no `stdin: 'stream'`, the old finite input/EOF behavior is unchanged. Async stdin
jobs wait without blocking the Worker. **Legacy/WASI synchronous stdin cannot wait**:
it consumes bytes already available and returns EOF when empty; interactive programs
must use async stdin. The lower-level equivalent is `createBrowserHost({stdin: new
BrowserStdin(), resolveCommand})` followed by `host.run(bytesOrModule, {name, args})`;
feed its input with `BrowserStdin.write/end`. A Host is a per-top-Run view; create a fresh
one for another run. Core `run(loaded, host, options)` remains available for finite input,
but use `host.run` for this extension's signal/lifetime handling.

`running.signal(2)` (or `host.signal(2)`) delivers SIGINT to the top Run's existing signal
capture/cancellation machinery. A shell's process cancellation stops its foreground
child through the existing process jobs; in cli/sh 0.2.1 this ends the shell Run with
signal 2 too. The default call still returns `void`.

For tty-style foreground process-group delivery, include the top Run and its commands:

```ts
const delivered = await running.signal(2, { target: 'group' });
// true means at least one live process received the signal, including the top Run.
```

This returns a `Promise<boolean>` acknowledged by the Worker. The run is treated as one
foreground process group: **the top-level guest and all live wasm descendants** started
through the browser ProcessPort, including nested shells and their commands. Each receives the
signal through its normal path: the top Run's signal dispatch, or `process.kill` for a
child. A guest that captured the signal runs its handler; otherwise the default action
applies. `true` means delivery to at least one live process, not that it has finished.
The top Run alone is sufficient, even without a resolver or children. After the Run
ends the result is `false`. Commands still being resolved and future children are not
included. There is no pgid/tty or job-selection API; the embedder chooses the foreground
run, and every live process in that run belongs to its group.

Shells must catch SIGINT themselves to survive group delivery, as POSIX interactive
shells do. **cli/sh 0.2.1 currently does not**: group SIGINT while it runs cat ends both,
matching real moonrun in a pty, rather than producing another shell prompt. A parent
guest that captures SIGINT can continue and wait for its interrupted child normally.

The lower-level `host.signal(2, {target: 'group'})` returns the same boolean synchronously.
A known child pid can also be signaled with `host.process.kill(pid, signal)` (1/2/9/15;
0 probes existence). Virtual signals interrupt pending streaming stdin reads with EINTR
so cancellation can finish, while leaving the shared input open for a surviving parent.
A child terminated by SIGINT produces `{kind: 'signaled', signal: 2}`, which the existing
kernel exposes as `-2`; cli/sh's conversion is `$? = 130` when the shell itself survives.
The acknowledgment does not replace the guest's normal wait/status machinery.

Signals are cooperative at imports/suspension points; code that never yields or calls
imports blocks the shared Worker and cannot be preempted by a message. Terminating the
Worker externally stops the entire tree, rather than an individual wasm child.

## Relay protocol: `moonrun-tcp-v1`

One WebSocket represents one TCP connection. Negotiate this subprotocol at `/relay`.
Text frames carry JSON controls, binary frames carry opaque bytes (including TLS records).

| Direction | Message | Meaning |
|---|---|---|
| client → relay | `{type:"connect",host,port,credit:131072}` | Allowed hostname/IP and initial receive credit |
| relay → client | `{type:"connected"}` | TCP connected, publish writable readiness |
| either | binary | Unmodified stream data; client frames are at most 64 KiB |
| relay → client | `{type:"ack",bytes}` | TCP write callback completed for these bytes |
| client → relay | `{type:"credit",bytes}` | Receive capacity released; resume TCP reads |
| relay → client | `{type:"end"}` | Peer FIN; receiving side reaches EOF, sending remains open |
| client → relay | `{type:"end"}` / `{type:"reset"}` | Close: flush accepted writes then FIN / discard and reset |
| client → relay | `{type:"no-delay",enabled}` | TCP_NODELAY |
| client → relay | `{type:"keep-alive",enabled,idleSeconds}` | SO_KEEPALIVE |
| relay → client | `{type:"error",code}` | POSIX failure; unknown codes become EIO in the Host |

`BrowserDns` returns stable per-run IPv4 aliases in `198.18.0.0/15` for valid DNS names.
Names are lowercased and a final dot is removed. Literals remain literal. The NetPort
replaces a known alias with its hostname in `connect`; actual DNS is done by the relay,
so address-family choice and DNS failure timing differ from moonrun (D43). The fake
range is reserved within a run; a literal equal to an allocated alias also maps to that
name. Alias results are not suitable for security authorization or external networking.

The existing kernel supplies EINPROGRESS, EAGAIN, buffered reads, EOF and edge readiness.
The port returns false after 64 KiB of unacknowledged writes and emits `drain` when below
that mark. Receive credit plus the kernel's pause/resume bounds received buffering;
credit is withheld while paused. The relay limits WebSocket messages to 1 MiB and pending
TCP writes to 8 MiB (ENOBUFS), with a 10s connect deadline and 60s TCP idle timeout. It
never unwraps TLS. Listen/accept, UDP and network interface enumeration are unavailable.

## Expected scope and verification

Pure computation, core/legacy output, args/env, finite stdin, ordinary memory filesystem
I/O, async timers, and SQLite using the same synchronous VFS are supported. Filesystem
watching, native processes, OS/tty signals, listeners and UDP are unavailable. Persistence
and picked host folders require explicit async mounts; wasm processes and virtual signals
are opt-in too. Memory files remain limited to 64 MiB, metadata is synthetic and directory
order is insertion order; mounted file sizes and order come from their providers (D41–D47).

Expected skill cases: kbbi/discord-cli `--help` and discord-cli's no-token error require
no network. kbbi lookup, discord-cli API calls and web-fetch of `https://example.com`
should work through the default allowlist and relay roots; other web-fetch destinations
need `--allow`. Skills that launch provided wasm commands can use the resolver or filesystem paths; native binaries,
UDP/listeners remain unavailable; host files require a granted directory handle mount.
This is expected coverage, **not a Chrome test result**.

Node/vitest tests cover VFS contracts, DNS aliases, relay authentication and destination
rejection, opaque data and FIN, EAGAIN/drain, receive credit, component preparation,
guest args/env/stdio/exit, SQLite commits and reopen, and the real Worker entry via a Node transport bridge.
`pnpm build` traverses emitted browser dependencies, rejects Node and bare imports and
checks wasm/Worker assets. Chrome verification is left to the coordinator; no browser
or persistent demo server is started as part of implementation verification.

The shell tests download cli/sh, cli/tr, cli/cat, cli/ls, cli/grep and cli/echo 0.2.1 only
into `.cache/browser-shell/` and
verify fixed SHA-256 digests on every use. Tests compare pipelines, missing-command
messages/status, nested sh and interactive output with the Node CLI using native host
commands. Additional tests cover large pipeline backpressure, cwd/env/file redirection,
merged output, precompiled children, traps/compile failures, kill/wait and SIGINT.
Resolver rewrite tests run cli/echo 0.2.1 with consumed dispatch arguments, pipe its output
through tr, and verify argv0/optional fields using the existing WASI argv fixture. Wrapped
Modules and bytes cross a real Worker transport; raw return types remain covered.
Group SIGINT tests cover cli/sh with a streaming cat, a cat pipeline and a nested shell,
checking that the top Run ends too, plus delivery with no children. A small WAT parent
captures SIGINT through the guest ABI, survives, and verifies its child's wait status -2.
Mount tests run ls/cat/grep against delayed main-thread providers through a real Worker,
test mounted redirects, longest-prefix routing, read-only failures, caching and issued-job
cancellation, and exercise the native-directory provider with fake Web API handles.
Small WASI and legacy guests pin the synchronous cache limitation.
Real cli/cp, cli/cat, cli/head, cli/wc, cli/sort and cli/ls 0.2.1 regressions cover
cached/uncached fake providers and the directory-handle adapter. cp copies binary data
in both directions between memory and mounts through child Host views. These fixtures
use new destinations and `--no-preserve=mode`: cli/cp 0.2.1 itself rejects permission
preservation and overwrites independently of the Host. Async open-stat/fstatx and
size/time jobs always use async descriptor metadata, including with `cache: false`;
only stdio descriptors use the Host's synthetic stat shim.
Path-execution tests cover memory files, absolute/relative spawn cwd paths, nested shells,
pipes, uncached mounted files through Worker RPC with short reads, child PATH order,
empty/relative PATH components, format/permission candidate skipping, resolver fallback,
VFS writes between lookups, defaults and opting out. Tests also observe cli/sh's external
`command`/`which` requests. ENOENT/ENOEXEC/EACCES messages and cli/sh status 127 are
pinned against observations with real moonrun and equivalent native files.
