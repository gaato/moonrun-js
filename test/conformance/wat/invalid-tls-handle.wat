;; Ported from moon crates/moonrun/tests/engine_backends.rs (tls_free_rejects_zero_handle)
(module
                    (import "moonbitlang/async" "tls/connection/free" (func $free (param i64)))
                    (memory (export "memory") 1)
                    (func (export "_start") (call $free (i64.const 0))))
