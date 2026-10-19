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
Worker, with fresh environment, DNS mappings and filesystem. Reload to stop a guest
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
Chrome restricts large synchronous module compilation on the main thread. Args go to
`run(loaded, host, { args })`, rather than Host (the existing core contract).

Host options additionally allow a synchronous stdin byte-source callback, `BrowserStdin`,
cwd, and explicit DER `roots`. Output callbacks receive owned byte copies. `runInWorker`
keeps callbacks on the main thread and sends cloneable messages to the Worker. Its return
value remains an awaitable Promise of the existing `RunOutcome`, with input/signal methods
as described below; it terminates the Worker on outcomes and Worker errors.
Output-callback/structured-clone exceptions reject its Promise after termination.

With a relay, Host preparation fetches `/roots` using the same token query: a JSON array
of base64 DER certificates from the relay machine's existing `nodeTrustStore` adapter
(including its documented Node fallback, D24). An explicit `roots` array overrides this.
Without a relay or explicit roots the system-root list is empty. TLS verification is
never disabled. These are **not the browser's roots** (D44).

## Wasm child commands and streaming input

These are optional **browser extensions**, not native moonrun process behavior (D45–D46).
No command registry, package resolver, network fetcher or application UI is included.

```ts
const running = runInWorker({
  wasm: shellBytes,
  name: 'sh',
  args: ['-i'],
  stdin: 'stream',
  // Executed on the main thread. The embedder supplies all resolution and loading.
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

`resolveCommand(program, args, {cwd, env})` returns a Promise of wasm bytes, a compiled
`WebAssembly.Module`, or `undefined`. `program` is exactly the guest's request, `args`
excludes argv[0], cwd is an existing absolute directory, and env is the child's complete
snapshot (first repeated key wins). The callback owns PATH/catalog policy: the Host does
not search, fetch or cache commands. `undefined` gives ENOENT; cli/sh prints
`sh: OSError("@process.run(): No such file or directory")` and sets status 127, exactly
as with a missing native command. A callback rejection gives EIO. If passing a Module,
the embedder should compile with MoonBit's js-string builtins/options when needed;
bytes go through the existing compatibility compiler. Without a resolver, process
spawn/kill/policy-transfer continue to return ENOSYS.

Resolved commands execute as separate Runs **inside the same Worker**. Each gets its
spawn argv[0], args, environment, cwd view, diagnostics and kernel state; inodes and
open-file descriptions are shared through the memory VFS. Duplicated file descriptors
share offsets and survive parent closure. Components and trust roots are reused.
Nested children use the same resolver. Pids increase from 1 within each Worker and
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
result cannot create an orphan Run. Detached/background lifetimes across top Runs are
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
through `resolveCommand`, including nested shells and their commands. Each receives the
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
watching, native processes, OS/tty signals, listeners, UDP, persistent storage and access
to host files are unavailable; optional wasm processes and virtual signals are described above. Paths are UTF-8 strings, metadata is synthetic, files are
limited to 64 MiB, and directory order is insertion order (D41–D44).

Expected skill cases: kbbi/discord-cli `--help` and discord-cli's no-token error require
no network. kbbi lookup, discord-cli API calls and web-fetch of `https://example.com`
should work through the default allowlist and relay roots; other web-fetch destinations
need `--allow`. Skills that launch provided wasm commands can use the resolver; native binaries,
UDP/listeners and host files remain unavailable. This is expected coverage, **not a Chrome test result**.

Node/vitest tests cover VFS contracts, DNS aliases, relay authentication and destination
rejection, opaque data and FIN, EAGAIN/drain, receive credit, component preparation,
guest args/env/stdio/exit, SQLite commits and reopen, and the real Worker entry via a Node transport bridge.
`pnpm build` traverses emitted browser dependencies, rejects Node and bare imports and
checks wasm/Worker assets. Chrome verification is left to the coordinator; no browser
or persistent demo server is started as part of implementation verification.

The shell tests download cli/sh, cli/tr and cli/cat 0.2.1 only into `.cache/browser-shell/` and
verify fixed SHA-256 digests on every use. Tests compare pipelines, missing-command
messages/status, nested sh and interactive output with the Node CLI using native host
commands. Additional tests cover large pipeline backpressure, cwd/env/file redirection,
merged output, precompiled children, traps/compile failures, kill/wait and SIGINT.
Group SIGINT tests cover cli/sh with a streaming cat, a cat pipeline and a nested shell,
checking that the top Run ends too, plus delivery with no children. A small WAT parent
captures SIGINT through the guest ABI, survives, and verifies its child's wait status -2.
