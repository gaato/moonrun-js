;; Ported from moon crates/moonrun/tests/engine_backends.rs (current_exe_imports_report_missing_origin_to_guest)
;; Template: {{name}} placeholders are filled from "vars" in the case file.
(module
                        (import "moonbitlang/core" "{{import}}"
                            (func $path (result i64)))
                        (import "moonbitlang/async" "os_error/get_errno"
                            (func $errno (result i32)))
                        (import "moonbitlang/sqlite" "sqlite3_null_handle"
                            (func $null (result i64)))
                        (import "moonbitlang/async" "c_buffer/is_null"
                            (func $is_null (param i64) (result i32)))
                        (memory (export "memory") 1)
                        (func (export "_start") (local $buffer i64)
                            (if (call $errno) (then unreachable))
                            (local.set $buffer (call $path))
                            (if (i64.ne (local.get $buffer) (call $null)) (then unreachable))
                            (if (i32.eqz (call $is_null (local.get $buffer))) (then unreachable))
                            (if (i32.eqz (call $errno)) (then unreachable))))
