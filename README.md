# moonrun-js

[![npm](https://img.shields.io/npm/v/moonrun-js)](https://www.npmjs.com/package/moonrun-js)
[![CI](https://github.com/gaato/moonrun-js/actions/workflows/ci.yml/badge.svg)](https://github.com/gaato/moonrun-js/actions/workflows/ci.yml)
[![compat: moonrun 0.1.20261023](https://img.shields.io/badge/compat-moonrun%200.1.20261023-blue)](docs/divergences.md)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/gaato/moonrun-js)
[![License](https://img.shields.io/github/license/gaato/moonrun-js)](LICENSE)

A TypeScript reimplementation of [MoonBit](https://www.moonbitlang.com/)'s `moonrun`, the
wasm runner bundled with the MoonBit toolchain. Programs built with `moon build --target wasm`
or `--target wasm-gc` that run under `moonrun` run on Node.js, Deno and Bun, including programs
that use `moonbitlang/async` (files, processes, signals, TCP/UDP, DNS, TLS) and
`moonbitlang/sqlite`.

The yardstick is the real `moonrun` 0.1.20261023 (moon `3778465`): the same wasm should
produce the same stdout, stderr and exit status. Known differences are listed with IDs in
[docs/divergences.md](docs/divergences.md).

## Usage

```sh
npx moonrun-js program.wasm -- arg1 arg2
```

On Deno or Bun:

```fish
deno run -A npm:moonrun-js program.wasm -- arg1 arg2
bunx --bun moonrun-js program.wasm -- arg1 arg2
```

The arguments follow `moonrun`: `[--test-args JSON] [--policy FILE [--policy-source-dir DIR]]
[--no-stack-trace] <wasm> [-- args...]`.

`moon` can use it in place of `moonrun`:

```sh
MOONRUN_OVERRIDE=$(command -v moonrun-js) moon test --target wasm
```

## Runtimes

| Runtime | Status |
|---|---|
| Node.js ≥ 24 | Matches core; cross-process file-lock tests differ because locks are scoped to one Run |
| Deno | Matches core; cross-process locks, a few socket and file timestamp cases differ |
| Bun | Core outcomes match, with unnamed wasm stack frames; async has lock/socket differences and an unresolved `Process::wait` timing assertion |

Every known difference is listed in [docs/divergences.md](docs/divergences.md). JSPI
(`WebAssembly.Suspending`), Wasm GC and exception handling are required.

moonrun-js always behaves as Linux (errno values, `stat` layout, platform queries). Parts of
moonrun's own Rust source (sandbox policy, filesystem checks, diagnostics, argument parsing)
are compiled to wasm and shipped with the package, as are a rustls TLS engine and SQLite
3.53.2. No native addons are used.

## Library

`moonrun-js` exports `compileBytes` and `run`, and `moonrun-js/node` exports `nodeHost`. This
API is not stable yet.

## Browser

A Web API host and dedicated Worker runner are exported from `moonrun-js/browser`.
Try it at <https://moonrun.gaa.to>: a shell running cli/sh and the cli/* commands from [moonbit-community/cmd](https://github.com/moonbit-community/cmd) in the browser.
Embedders can mount asynchronous filesystem providers, including user-picked folders and OPFS; see [browser mounts](docs/browser.md#asynchronous-filesystem-mounts).
From a checkout, start the local demo with:

```fish
mise exec -- pnpm demo:browser
```

Open the printed localhost URL in Chrome, select a wasm, enter arguments and Run.
Output streams as bytes; files live in memory under `/work`. HTTPS uses rustls over a
localhost WebSocket relay with an explicit destination allowlist and the relay machine's
roots. Native processes, OS signals, listeners and UDP are unavailable; persistent files require explicit mounts.
See [browser setup, embedding and relay protocol](docs/browser.md). Chrome verification
is pending; automated coverage runs under Node without a browser.

## Development

See [AGENTS.md](AGENTS.md) and [docs/plan.md](docs/plan.md). After cloning:

```sh
git submodule update --init --depth 1
mise install
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
