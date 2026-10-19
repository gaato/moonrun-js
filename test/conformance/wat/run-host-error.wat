;; Ported from moon crates/moonrun/tests/engine_backends.rs (wasmtime_preserves_host_adapter_errors_from_exported_calls)
(module
                (import "_" "filename" (global $filename (ref extern)))
                (import "__moonbit_fs_unstable" "begin_read_string"
                    (func $begin_read_string (param externref) (result externref)))
                (import "console" "log" (func $log (param (ref extern))))
                (func (export "_start")
                    global.get $filename
                    call $begin_read_string
                    ref.as_non_null
                    call $log))
