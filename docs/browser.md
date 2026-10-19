# Browser host and local demo (P7)

From a checkout with dependencies installed, one command builds and starts the demo:

```fish
mise exec -- pnpm demo:browser
```

Open the printed `http://127.0.0.1:8080/?token=…` URL in Chrome with JSPI enabled in
its engine. Select a `.wasm` or paste a CORS-enabled URL, enter arguments as a JSON
array (without the CLI `--` separator), then Run. stdout/stderr stream separately;
the status shows the `RunOutcome` and exit code. Stdin is finite UTF-8 input. Extra
files are preloaded under `/work`. Each Run creates and terminates a dedicated module
Worker, with fresh environment, DNS mappings and filesystem. Reload to stop a guest
that never finishes. There is no interactive stdin or persistent filesystem UI.

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

Host options additionally allow a synchronous stdin byte-source callback, cwd, and
explicit DER `roots`. Output callbacks receive owned byte copies. `runInWorker` accepts
only cloneable input, strips callbacks before posting, streams copied byte chunks back,
and resolves the existing `RunOutcome`; it terminates the Worker on outcomes and Worker
errors. Callback/structured-clone exceptions reject its Promise after termination.

With a relay, Host preparation fetches `/roots` using the same token query: a JSON array
of base64 DER certificates from the relay machine's existing `nodeTrustStore` adapter
(including its documented Node fallback, D24). An explicit `roots` array overrides this.
Without a relay or explicit roots the system-root list is empty. TLS verification is
never disabled. These are **not the browser's roots** (D44).

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
watching, external processes, OS signals, listeners, UDP, persistent storage and access
to host files are unavailable. Paths are UTF-8 strings, metadata is synthetic, files are
limited to 64 MiB, and directory order is insertion order (D41–D44).

Expected skill cases: kbbi/discord-cli `--help` and discord-cli's no-token error require
no network. kbbi lookup, discord-cli API calls and web-fetch of `https://example.com`
should work through the default allowlist and relay roots; other web-fetch destinations
need `--allow`. Skills that launch programs or require UDP/listeners/host files do not
work here. This is expected coverage, **not a Chrome test result**.

Node/vitest tests cover VFS contracts, DNS aliases, relay authentication and destination
rejection, opaque data and FIN, EAGAIN/drain, receive credit, component preparation,
guest args/env/stdio/exit, SQLite commits and reopen, and the real Worker entry via a Node transport bridge.
`pnpm build` traverses emitted browser dependencies, rejects Node and bare imports and
checks wasm/Worker assets. Chrome verification is left to the coordinator; no browser
or persistent demo server is started as part of implementation verification.
