;; Ported from moon crates/moonrun/tests/engine_backends.rs (wasmtime_authorizes_before_reading_byte_handles)
(module
                (import "_" "denied.bin" (global $path (ref extern)))
                (import "_" "not bytes" (global $not_bytes (ref extern)))
                (import "__moonbit_fs_unstable" "write_bytes_to_file_new"
                    (func $write (param externref externref) (result i32)))
                (import "__moonbit_fs_unstable" "get_error_message"
                    (func $get_error_message (result externref)))
                (import "console" "log" (func $log (param (ref extern))))
                (func (export "_start")
                    global.get $path
                    global.get $not_bytes
                    call $write
                    drop
                    call $get_error_message
                    ref.as_non_null
                    call $log))
