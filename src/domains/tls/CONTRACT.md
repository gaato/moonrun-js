# TLS contract (moonrun 748b63c, Linux)

Sources: `crates/moonrun/src/` at 748b63c — `async_api/tls.rs` (import shims, `AT`),
`async_host/mod.rs` (handle table, `MOD`), `async_host/tls/mod.rs` (`TLS`),
`async_host/tls/openssl.rs` (`OSSL`). Guest side: moonbitlang/async 777da33
`src/tls/tls.wasm.mbt` (`MBT`). `TlsSession` (session.ts) implements the handle
level, `crates/tls-engine` (conn.rs) the connection level.

## Handles
- `tls/connection/new` always succeeds and returns an empty (pending) handle
  (MOD 3779-3785). A pending handle holds root certificates and `last_error`
  (TLS 145-183). `set_client` / `set_server_files` / `set_server_pfx` turn it
  into a connection on success; on failure it stays pending with the error set.
- Configuring a handle that is already a connection, `add_root_certificate`
  on a connection: `Inval` host error (MOD 3804, 3854, 3878, 4018-4027).
- `free` of the null handle is a no-op, of an unknown handle `Badf` (MOD 3882-3893).
- Any connection operation on a pending handle sets `"TLS handle is not
  configured"` and returns the "unconfigured value" (MOD 4003-4016): `-1` for
  read/write/shutdown, `Error` (3) for connect/accept, `0` for the byte
  counters, false for the wants, null buffers for the certificate and bindings.
- `take_error` returns and clears the last error, `"unknown TLS error"` when
  none (MOD 3756-3768). `tls/error/take_global` is always `"unknown TLS error"`:
  the field is never written at 748b63c (MOD 1101, 1149, 3770-3777).

## Configuration
- `set_client(host: UTF-16, sni: i32 != 0, trust)`. Trust ABI 0 no
  verification, 1 system roots, 2 only `add_root_certificate` roots; any other
  value is `Inval` before the handle is looked up (AT 36-50, TLS 105-117).
- Roots are DER (`X509::from_der`) and only parsed at `set_client`: a bad one
  fails with `"failed to parse TLS root certificate: …"` (OSSL 750-762).
  `add_root_certificate` always returns 0 and clears `last_error` (TLS 167-171).
- Roots with trust ≠ 2: `"TLS root certificates require custom root trust"`
  (OSSL 63-65). Trust 1: system roots via openssl-probe, failure
  `"failed to load system TLS roots: …"` (OSSL 71-75, 721-748).
- Empty host: no SNI and no hostname check (chain still verified for trust 1/2).
  `sni = 0`: no SNI, hostname still verified. IP literals are checked as IP
  SANs (`set_ip`). Hostname matching uses `NO_PARTIAL_WILDCARDS` (OSSL 86-97,
  709-719). Trust 0 skips chain and name checks (OSSL 70, 92).
- `set_server_files(key path, key type, cert path, cert type)`: types 1 PEM,
  2 ASN.1/DER, else `Inval` (TLS 85-96, AT 65-88). Order: policy read check
  of the key then the certificate (`"failed to access TLS private key file:
  {err:?}"`), roots present → `"TLS root certificates require client custom
  root trust"`, then load the certificate (PEM = chain file, `"failed to load
  TLS certificate chain: …"`; DER = single, `"failed to load TLS certificate:
  …"`), then the key (`"failed to load TLS private key: …"`, also on a key that
  does not match) (MOD 3816-3856, OSSL 128-139).
- `set_server_pfx`: roots check, then always `"TLS PFX server certificates are
  supported only by SChannel on Windows"` (MOD 3858-3880, OSSL 116-123).
  moonrun-js always behaves as Linux.

## Data path
Each call gets the guest's encrypted input and an output slice (AT 120-224);
afterwards `bytes_read` = input consumed, `bytes_to_write` = output produced
(OSSL 276-305); both reset at the start of every call.
- `connect`/`accept` return `TlsState` 0 Completed, 1 WantRead, 2 WantWrite,
  3 Error, 4 Eof, 5 ReNegotiation: `from_status(-3)` is WantWrite when
  `wants_write`, else WantRead (TLS 46-77, MOD 3919-3941). The wrong side
  errors: `"TLS connect requires a client handle"` / `"TLS accept requires a
  server handle"` (OSSL 244-256). After the handshake connect/accept return
  Completed without touching the input (OSSL 362-367).
- `read_plain` / `write_plain` return a byte count or -1 error, -2 closed,
  -3 would block, -4 renegotiation (TLS 40-44). `read_plain`: empty plaintext
  buffer → 0 first; while handshaking → -4 without I/O (`wants_read` true);
  close_notify received → -2 (OSSL 173-192). `write_plain`: empty → 0; after
  `shutdown` → -2; while handshaking → -4 (OSSL 198-225).
- `with_scoped_io`: whenever output was produced and the status is -3/-4,
  `wants_write` becomes true (OSSL 296-300). Initial `wants_write` is true
  (OSSL 158).
- `shutdown` only sets a flag and returns 0 (OSSL 239-242); the next
  connect/accept sends close_notify instead of handshaking and returns
  Completed (OSSL 266-274, 307-326). It does not wait for the peer's
  close_notify. Shutting down during the handshake fails (`SSL_shutdown`
  "shutdown while in init").
- Error texts are `"{context}: {error}"` with contexts `TLS handshake failed`,
  `TLS plaintext read failed`, `TLS plaintext write failed`, `TLS shutdown
  failed` (OSSL 382, 190, 223, 324, 429).

## Certificates and channel bindings
- `peer_certificate`: DER of the peer's leaf; an empty (non-null) buffer when
  absent — before the first connect/accept, or on a server (no client auth);
  null only on error (OSSL 433-446, MOD 3967-3975). The guest only asks as a
  client (MBT 628-638).
- `unique_channel_binding` (tls-unique): OpenSSL `SSL_get_finished` on the
  client, `SSL_get_peer_finished` on the server — the client Finished
  verify_data in TLS 1.2 and 1.3 (OSSL 448-469). None → null (MOD 3991-4001).
- `server_endpoint_channel_binding` (RFC 5929): hash of the server
  certificate (peer's on the client, own on the server) with the digest of its
  signature algorithm, MD5/SHA-1 → SHA-256; no digest (RSASSA-PSS, Ed25519) →
  error `"tls-server-endpoint channel binding unavailable"` (OSSL 471-488,
  771-787).

## How moonrun-js realizes it (engine side)
- rustls' unbuffered API reassembles handshake messages in place and keeps
  that state across calls, so every byte of input a call needs is moved into
  the engine (`bytes_read` = input length). The guest only reads more after
  WantRead / -3 with `wants_read`, so this stays bounded. `write_plain` never
  consumes input.
- Records that do not fit into the output slice stay in the engine and
  `wants_write` reports them (truthful flag, plus the OSSL 296-300 rule).
  Application data is only accepted when its records fit into the output
  slice, so a successful `write_plain` never leaves ciphertext behind (OpenSSL
  likewise holds an unwritten record and returns -3 until it is out).
- After a fatal error the alert rustls queues is put into the output, as
  OpenSSL does; the guest drops it when it raises (MBT 315).
- tls-unique is observed through delegates around ring's HKDF (TLS 1.3
  `hmac_sign`) and PRF (TLS 1.2 label `client finished`); see provider.rs.
- Verification follows OpenSSL where async's tests depend on it: a leaf that is
  itself a trusted root is accepted (validity checked), and with no DNS SAN the
  last subject CN is matched (verify.rs).

## Known differences (docs/divergences.md candidates)
- Error texts come from rustls, not OpenSSL (`TLS handshake failed: invalid
  peer certificate: UnknownIssuer` vs `…certificate verify failed…`).
- rustls never sends an IP literal (or an invalid DNS name) as SNI; OpenSSL does.
- TLS 1.0/1.1 and renegotiation are not supported; -4 is only returned before
  the handshake completes.
- webpki rejects a `CA:TRUE` leaf that chains to a *different* root
  (`CaUsedAsEndEntity`); OpenSSL accepts it.
- tls-server-endpoint for SHA-224 signatures is "unavailable" (ring has no SHA-224).
- System roots on a host without any OpenSSL location fall back to Node's
  store; moonrun would have none.
