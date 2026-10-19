;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (array_helpers_and_string_array_end_sentinel_are_preserved)
(module
        (import "__moonbit_fs_unstable" "args_get" (func $args (result externref)))
        (import "__moonbit_fs_unstable" "array_len" (func $len (param externref) (result i32)))
        (import "__moonbit_fs_unstable" "array_get" (func $get (param externref i32) (result externref)))
        (import "__moonbit_fs_unstable" "begin_read_string_array" (func $reader (param externref) (result externref)))
        (import "__moonbit_fs_unstable" "string_array_read_string" (func $read (param externref) (result externref)))
        (import "__moonbit_fs_unstable" "finish_read_string_array" (func $close (param externref)))
        (import "wasm:js-string" "equals" (func $equals (param externref externref) (result i32)))
        (import "_" "ffi_end_of_/string_array" (global $end externref))
        (func (export "_start") (local $a externref) (local $r externref)
            call $args local.set $a
            local.get $a call $len i32.const 1 i32.ne if unreachable end
            local.get $a call $reader local.set $r
            local.get $r call $read local.get $a i32.const 0 call $get
            call $equals i32.eqz if unreachable end
            local.get $r call $read global.get $end call $equals i32.eqz if unreachable end
            local.get $r call $close
            local.get $r call $read global.get $end call $equals i32.eqz if unreachable end))
