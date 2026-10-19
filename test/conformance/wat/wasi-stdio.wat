;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_share_the_wasip1_adapter)
(module
                (import "wasi_snapshot_preview1" "fd_read"
                    (func $fd_read (param i32 i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_write"
                    (func $fd_write (param i32 i32 i32 i32) (result i32)))
                (memory (export "memory") 1)
                (func $ok (param $errno i32)
                    local.get $errno
                    if unreachable end)
                (func (export "_start")
                    i32.const 16 i32.const 32 i32.store
                    i32.const 20 i32.const 64 i32.store
                    i32.const 0 i32.const 16 i32.const 1 i32.const 24 call $fd_read call $ok
                    i32.const 20 i32.const 24 i32.load i32.store
                    i32.const 1 i32.const 16 i32.const 1 i32.const 28 call $fd_write call $ok))
