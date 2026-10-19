# Patches

## ring-0.17.14-wasm32-custom-getrandom.patch (needed)

`ring::rand::SystemRandom` implements `SecureRandom` only for a fixed list of
targets (`src/rand.rs`). On `wasm32-unknown-unknown` it is enabled only with
the `wasm32_unknown_unknown_js` feature, which pulls `getrandom/js` and thus
wasm-bindgen imports. The `less-safe-getrandom-custom-or-rdrand` feature that
would route it to getrandom's custom backend is limited to `target_os = "none"`
(ring docs: "This feature only works with os = "none" targets").

rustls' ring provider calls `SystemRandom` directly (key exchange, ECDSA/RSA
signing, `CryptoProvider::secure_random`), and ring's `SecureRandom` trait is
sealed, so the generator cannot be replaced from outside. The patch adds one
`cfg` arm so that the same feature also applies to `wasm32-unknown-unknown`;
getrandom 0.2's `custom` backend then calls the engine's `env.random_fill`.

ring 0.17.14 is the latest release (checked 2026-10-19). `scripts/build-tls.ts`
verifies the crates.io tarball's SHA-256, extracts it to
`.cache/tls-engine/ring-0.17.14` and applies the patch with `patch --forward`,
which fails if the pre-image no longer matches.

## rustls-pki-types (avoided)

`UnixTime::now()` does not exist on `wasm32-unknown-unknown` without the `web`
feature (web-time, i.e. wasm-bindgen), and rustls' `std` feature needs it. The
engine builds rustls without `std` and drives the unbuffered API, supplying the
time through a `TimeProvider`, so no patch is required.

## Rejected alternative

Building for `wasm32-wasip1` needs no patch at all, but the module then imports
`wasi_snapshot_preview1.{random_get, environ_get, environ_sizes_get, fd_write,
proc_exit}` (std's panic and environment handling); the plan keeps the engine
free of WASI with only `env.now_unix_ms` and `env.random_fill`.
