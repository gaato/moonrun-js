# Changelog

## 0.1.5 — 2026-10-24

- Track moonrun `0.1.20261023` (`3778465`) and the matching async source revision.
- Reuse upstream parsing for `.mbtx` permission front matter and preserve legacy YAML support.
- Render named Wasm frames with source and runtime locations; recover Deno's named-frame function indices from module offsets.
- Add the upstream console stdio/stat classification and console job imports, retaining Linux `ENOSYS` and the legacy descriptor kind.
- Regenerate async/SQLite imports and reject incomplete SQLite registration extraction.
- In conformance tooling, invalidate stale toolchain/source caches and isolate CommonJS upstream test helpers from this package's ESM scope.

Known limitations: file locks remain local to one Run (D16). Bun's full async
comparison is **UNSTABLE**: a `Process::wait` test measures less than 500 ms after
spawn returns, although the observed total duration exceeds 500 ms and the exit
code is correct. This assertion is not suppressed. Deno/Bun socket and engine
limitations remain documented in [docs/divergences.md](docs/divergences.md).
