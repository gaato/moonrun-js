;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_reuse_worker_with_owned_completion_pipe)
(module
                (import "moonbitlang/async" "fd_util/pipe"
                    (func $pipe (param i32 i32 i32 i32) (result i32)))
                (import "moonbitlang/async" "fd_util/close_fd"
                    (func $close (param i64) (result i32)))
                (import "moonbitlang/async" "thread_pool/make_sleep_job"
                    (func $sleep_job (param i32) (result i64)))
                (import "moonbitlang/async" "thread_pool/make_read_job"
                    (func $read_job (param i64 i32 i64) (result i64)))
                (import "moonbitlang/async" "thread_pool/run_job"
                    (func $run (param i64)))
                (import "moonbitlang/async" "thread_pool/get_read_result"
                    (func $read_result (param i64 i32 i32 i32)))
                (import "moonbitlang/async" "thread_pool/job_get_ret"
                    (func $ret (param i64) (result i32)))
                (import "moonbitlang/async" "thread_pool/job_get_err"
                    (func $err (param i64) (result i32)))
                (import "moonbitlang/async" "thread_pool/free_job"
                    (func $free_job (param i64)))
                (import "moonbitlang/async" "thread_pool/spawn_worker_with_pipe"
                    (func $spawn (param i32 i64 i64) (result i64)))
                (import "moonbitlang/async" "thread_pool/wake_worker"
                    (func $wake (param i64 i32 i64)))
                (import "moonbitlang/async" "thread_pool/free_worker"
                    (func $free_worker (param i64)))
                (memory (export "memory") 1)
                (func $receive (param $expected i32) (param $job i64)
                    (local $read i64)
                    (local.set $read (call $read_job (i64.load (i32.const 0))
                        (i32.const 4) (i64.const -1)))
                    (call $run (local.get $read))
                    (if (i32.ne (call $ret (local.get $read)) (i32.const 4))
                        (then unreachable))
                    (call $read_result (local.get $read) (i32.const 16)
                        (i32.const 0) (i32.const 4))
                    (if (i32.ne (i32.load (i32.const 16)) (local.get $expected))
                        (then unreachable))
                    ;; No event bus or private async completion drain was used.
                    (if (call $err (local.get $job)) (then unreachable))
                    (if (call $ret (local.get $job)) (then unreachable))
                    (call $free_job (local.get $read))
                    (call $free_job (local.get $job)))
                (func (export "_start")
                    (local $worker i64)
                    (local $job i64)
                    ;; Blocking reader, async writer (also exercises Windows OVERLAPPED).
                    (if (call $pipe (i32.const 0) (i32.const 2)
                        (i32.const 0) (i32.const 1)) (then unreachable))
                    (local.set $job (call $sleep_job (i32.const 0)))
                    (local.set $worker (call $spawn (i32.const 17)
                        (local.get $job) (i64.load (i32.const 8))))
                    ;; Closing guest reachability must not close the Worker's writer.
                    (if (call $close (i64.load (i32.const 8))) (then unreachable))
                    (call $receive (i32.const 17) (local.get $job))
                    (local.set $job (call $sleep_job (i32.const 0)))
                    (call $wake (local.get $worker) (i32.const 23) (local.get $job))
                    (call $receive (i32.const 23) (local.get $job))
                    (call $free_worker (local.get $worker))
                    ;; The last writer is released when the Worker is freed.
                    (local.set $job (call $read_job (i64.load (i32.const 0))
                        (i32.const 1) (i64.const -1)))
                    (call $run (local.get $job))
                    (if (call $ret (local.get $job)) (then unreachable))
                    (call $free_job (local.get $job))
                    (if (call $close (i64.load (i32.const 0))) (then unreachable))))
