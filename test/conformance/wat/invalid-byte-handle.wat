;; Ported from moon crates/moonrun/tests/engine_backends.rs (wasmtime_reports_invalid_byte_handles_as_host_errors)
;; Template: {{name}} placeholders are filled from "vars" in the case file.
(module
                    (import "_" "{{path}}" (global $path (ref extern)))
                    (import "_" "not bytes" (global $not_bytes (ref extern)))
                    (import "__moonbit_fs_unstable" "write_bytes_to_file"
                        (func $write (param externref externref)))
                    (func (export "_start")
                        global.get $path
                        global.get $not_bytes
                        call $write))
