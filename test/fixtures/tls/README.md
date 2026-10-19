# TLS test fixtures

- `cert.pem`, `key.pem`, `cert.pfx`, `valid_root_cert.pem`, `valid_root_key.pem`,
  `other_root_cert.pem`, `other_root_key.pem`: copied unchanged from
  moonbitlang/async `test_keys/` (Apache-2.0, Copyright International Digital
  Economy Academy). `cert.pem` expired in 2025 and is used only without
  verification, as in async's own tests.
- `ca.pem` / `ca-key.pem`: a test CA (RSA). `leaf.pem` / `leaf-key.pem` (PKCS#8
  P-256) and their DER forms `leaf.der` / `leaf-key.der`: a server certificate
  signed by it with sha384WithRSAEncryption, SAN `localhost`, `*.example.test`,
  `127.0.0.1`, valid until 2046. `leaf-chain.pem` = leaf + CA.

Throwaway keys for tests only.
