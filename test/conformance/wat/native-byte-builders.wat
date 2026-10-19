;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (byte_builders_copy_on_finish_and_readers_observe_mutation)
(module
        (import "__moonbit_fs_unstable" "begin_create_byte_array" (func $builder (result externref)))
        (import "__moonbit_fs_unstable" "byte_array_append_byte" (func $append (param externref i32)))
        (import "__moonbit_fs_unstable" "finish_create_byte_array" (func $finish (param externref) (result externref)))
        (import "__moonbit_fs_unstable" "begin_read_byte_array" (func $reader (param externref) (result externref)))
        (import "__moonbit_fs_unstable" "byte_array_read_byte" (func $read (param externref) (result i32)))
        (import "__moonbit_fs_unstable" "finish_read_byte_array" (func $close (param externref)))
        (import "ffi-bytes" "set" (func $set (param externref i32 i32) (result i32)))
        (import "ffi-bytes" "length" (func $length (param externref) (result i32)))
        (func $eq (param i32 i32) local.get 0 local.get 1 i32.ne if unreachable end)
        (func (export "_start") (local $b externref) (local $a externref) (local $r externref)
            call $builder local.set $b
            local.get $b call $finish call $length i32.const 0 call $eq
            local.get $b i32.const -1 call $append
            local.get $b i32.const 256 call $append
            local.get $b i32.const 300 call $append
            local.get $b call $finish local.set $a
            local.get $b i32.const 99 call $append
            local.get $a call $length i32.const 3 call $eq
            local.get $a call $reader local.set $r
            local.get $r call $read i32.const 255 call $eq
            local.get $a i32.const 1 i32.const 258 call $set i32.const 258 call $eq
            local.get $r call $read i32.const 2 call $eq
            local.get $r call $read i32.const 44 call $eq
            local.get $r call $read i32.const -1 call $eq
            local.get $r call $close
            local.get $r call $read i32.const -1 call $eq))
