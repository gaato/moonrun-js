;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (byte_memory_is_reacquired_after_growth_and_copies_are_independent)
(module
        (import "ffi-bytes" "memory" (memory 1))
        (import "ffi-bytes" "from_memory" (func $from (param i32 i32) (result externref)))
        (import "ffi-bytes" "get" (func $get (param externref i32) (result i32)))
        (import "ffi-bytes" "length" (func $len (param externref) (result i32)))
        (func $eq (param i32 i32) local.get 0 local.get 1 i32.ne if unreachable end)
        (func (export "_start") (local $a externref)
            i32.const 0 i32.const 65 i32.store8
            i32.const 0 i32.const 1 call $from local.set $a
            i32.const 0 i32.const 66 i32.store8
            local.get $a i32.const 0 call $get i32.const 65 call $eq
            i32.const 1 memory.grow i32.const 1 call $eq
            i32.const 65536 i32.const 90 i32.store8
            i32.const 65536 i32.const 1 call $from i32.const 0 call $get i32.const 90 call $eq
            i32.const 131071 i32.const 10 call $from call $len i32.const 1 call $eq
            i32.const -1 i32.const 2 call $from call $len i32.const 0 call $eq))
