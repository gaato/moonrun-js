;; Ported from moon crates/moonrun/tests/test.rs (engine_backends_share_the_async_host_adapter)
(module
            (import "moonbitlang/async" "time/get_ms_since_epoch"
                (func $now (result i64)))
            (import "moonbitlang/async" "random/fill"
                (func $random_fill (param i32 i32) (result i32)))
            (memory (export "memory") 1)
            (func (export "_start")
                call $now
                i64.eqz
                if unreachable end
                i32.const 16
                i32.const 32
                call $random_fill
                if unreachable end))
