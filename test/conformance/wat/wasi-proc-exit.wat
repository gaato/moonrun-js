;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_share_the_wasip1_adapter)
(module
                (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
                (func (export "_start") i32.const 7 call $proc_exit))
