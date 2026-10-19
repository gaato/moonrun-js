;; Ported from moon crates/moonrun/tests/engine_backends.rs (async_resource_spawn_requires_reserved_absence_sentinel)
;; Template: {{name}} placeholders are filled from "vars" in the case file.
(module
                        {{imports}}
                        (import "moonbitlang/async" "process/make_env"
                            (func $env (param i32) (result i64)))
                        (import "moonbitlang/async" "fd_util/invalid_fd"
                            (func $invalid (result i64)))
                        (import "moonbitlang/async" "event_bus/create"
                            (func $poll (result i64)))
                        (import "moonbitlang/async" "thread_pool/init_thread_pool"
                            (func $init (param i64) (result i64)))
                        (import "moonbitlang/async" "thread_pool/free_job"
                            (func $free (param i64)))
                        (memory (export "memory") 1)
                        (func (export "_start")
                            call $poll call $init drop
                            i32.const 0 i32.const 0 {{inputs}} {{stdio}} {{flags}}
                            call $spawn call $free))
