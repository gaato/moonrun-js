;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (invalid_handles_and_byte_ranges_throw_catchable_exceptions)
;; Template: {{name}} placeholders are filled from "vars" in the case file.
(module
            (import "ffi-bytes" "new" (func $new (param i32) (result externref)))
            (import "ffi-bytes" "get" (func $get (param externref i32) (result i32)))
            (import "ffi-bytes" "copy" (func $copy (param externref i32 externref i32 i32)))
            (import "__moonbit_fs_unstable" "begin_create_string" (func $builder (result externref)))
            (import "__moonbit_fs_unstable" "string_read_char" (func $read (param externref) (result i32)))
            (import "__moonbit_fs_unstable" "finish_create_byte_array" (func $finish_bytes (param externref) (result externref)))
            (func (export "_start") (local $a externref)
                i32.const 2 call $new local.set $a
                (block $caught
                    (try_table (catch_all $caught) {{operation}})
                    unreachable)))
