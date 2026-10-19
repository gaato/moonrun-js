;; Ported from moon crates/moonrun/tests/engine_backends.rs (async_resource_process_result_rejects_zero_handle)
;; Template: {{name}} placeholders are filled from "vars" in the case file.
(module
                    (import "moonbitlang/async" "process/get_process_result"
                        (func $result (param i64 i32 i32) (result i32)))
                    (import "moonbitlang/async" "fd_util/invalid_fd"
                        (func $invalid (result i64)))
                    (import "moonbitlang/async" "os_error/get_errno"
                        (func $errno (result i32)))
                    (memory (export "memory") 1)
                    (func (export "_start")
                        (if (i32.ne (call $result (i64.const 0) (i32.const {{pid}}) (i32.const 0))
                                    (i32.const -1)) (then unreachable))
                        (if (i32.ne (call $errno) (i32.const {{badf}})) (then unreachable))
                        (if (i32.ne (call $result (call $invalid) (i32.const {{pid}}) (i32.const 0))
                                    (i32.const -1)) (then unreachable))
                        (if (i32.ne (call $errno) (i32.const {{child}})) (then unreachable))))
