;; Ported from moon crates/moonrun/tests/engine_backends.rs (wasmtime_preserves_host_adapter_errors_from_exported_calls)
(module
                (import "__moonbit_fs_unstable" "begin_read_string"
                    (func $begin_read_string (param externref) (result externref)))
                (import "console" "log" (func $log (param (ref extern))))
                (func (export "moonbit_test_driver_internal_execute")
                    (param $file externref) (param i32)
                    local.get $file
                    call $begin_read_string
                    ref.as_non_null
                    call $log)
                (func (export "moonbit_test_driver_finish")))
