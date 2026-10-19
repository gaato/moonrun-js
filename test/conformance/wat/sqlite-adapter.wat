;; Ported from moon crates/moonrun/tests/test.rs (engine_backends_share_the_sqlite_wasm_adapter)
(module
            (import "moonbitlang/sqlite" "sqlite3_null_handle"
                (func $null_handle (result i64)))
            (import "moonbitlang/sqlite" "sqlite3_open_v2"
                (func $open (param i32 i32 i32 i32 i64) (result i32)))
            (import "moonbitlang/sqlite" "sqlite3_close"
                (func $close (param i64) (result i32)))
            (memory (export "memory") 1)
            (data (i32.const 16) ":memory:")
            (func (export "_start") (local $null i64)
                call $null_handle
                local.set $null
                i32.const 16
                i32.const 8
                i32.const 8
                i32.const 6
                local.get $null
                call $open
                if unreachable end
                i32.const 8
                i64.load
                call $close
                if unreachable end))
