;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (byte_to_string_conversion_does_not_depend_on_js_argument_stack_limits)
(module
        (import "ffi-bytes" "new" (func $new (param i32) (result externref)))
        (import "ffi-bytes" "asString" (func $string (param externref i32 i32) (result externref)))
        (import "wasm:js-string" "length" (func $len (param externref) (result i32)))
        (func (export "_start")
            i32.const 1048576 call $new
            i32.const 0 i32.const 1048576 call $string
            call $len i32.const 524288 i32.ne if unreachable end))
