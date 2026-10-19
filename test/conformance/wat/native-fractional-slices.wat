;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (fractional_slice_indices_truncate_before_relative_clamping)
(module
        (import "ffi-bytes" "memory" (memory 1))
        (import "ffi-bytes" "from_memory" (func $from (param f64 f64) (result externref)))
        (import "ffi-bytes" "length" (func $len (param externref) (result i32)))
        (import "ffi-bytes" "fill" (func $fill (param externref f64 i32 f64)))
        (import "ffi-bytes" "get" (func $get (param externref i32) (result i32)))
        (func $eq (param i32 i32) local.get 0 local.get 1 i32.ne if unreachable end)
        (func (export "_start") (local $a externref)
            f64.const -0.5 f64.const 3.5 call $from local.set $a
            local.get $a call $len i32.const 3 call $eq
            local.get $a f64.const -0.5 i32.const 65 f64.const 2.5 call $fill
            local.get $a i32.const 0 call $get i32.const 65 call $eq
            local.get $a i32.const 1 call $get i32.const 65 call $eq
            local.get $a i32.const 2 call $get i32.const 0 call $eq))
