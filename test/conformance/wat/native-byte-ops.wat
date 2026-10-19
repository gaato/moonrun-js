;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (byte_operations_preserve_overlap_clamping_and_utf16)
(module
        (import "ffi-bytes" "memory" (memory 1))
        (import "ffi-bytes" "from_memory" (func $from (param i32 i32) (result externref)))
        (import "ffi-bytes" "copy" (func $copy (param externref i32 externref i32 i32)))
        (import "ffi-bytes" "fill" (func $fill (param externref i32 i32 i32) (result externref)))
        (import "ffi-bytes" "get" (func $get (param externref i32) (result i32)))
        (import "ffi-bytes" "set" (func $set (param externref i32 i32)))
        (import "ffi-bytes" "length" (func $len (param externref) (result i32)))
        (import "ffi-bytes" "equals" (func $equals (param externref externref) (result i32)))
        (import "ffi-bytes" "asString" (func $string (param externref i32 i32) (result externref)))
        (import "__moonbit_fs_unstable" "begin_read_string" (func $reader (param externref) (result externref)))
        (import "__moonbit_fs_unstable" "string_read_char" (func $read (param externref) (result i32)))
        (data (i32.const 0) "\01\02\03\04\05\06")
        (data (i32.const 16) "\00\d8\41\00\ff\dc\99")
        (func $eq (param i32 i32) local.get 0 local.get 1 i32.ne if unreachable end)
        (func (export "_start") (local $a externref) (local $b externref) (local $r externref)
            i32.const 0 i32.const 6 call $from local.set $a
            local.get $a i32.const 1 local.get $a i32.const 0 i32.const 5 call $copy
            local.get $a i32.const 5 call $get i32.const 5 call $eq
            local.get $a i32.const 2 call $get i32.const 2 call $eq
            local.get $a i32.const 0 local.get $a i32.const 1 i32.const 5 call $copy
            local.get $a i32.const 0 call $get i32.const 1 call $eq
            local.get $a i32.const 4 call $get i32.const 5 call $eq
            local.get $a i32.const 0 local.get $a i32.const -2 i32.const 100 call $copy
            local.get $a i32.const 0 call $get i32.const 5 call $eq
            local.get $a i32.const -2 i32.const 300 i32.const 100 call $fill local.set $b
            local.get $a i32.const 4 call $get i32.const 44 call $eq
            local.get $b i32.const 5 call $get i32.const 44 call $eq
            local.get $a local.get $b call $equals i32.const 1 call $eq
            local.get $a i32.const -1 call $get i32.const 0 call $eq
            local.get $a i32.const 6 call $get i32.const 0 call $eq
            local.get $a i32.const 6 i32.const 123 call $set
            local.get $a call $len i32.const 6 call $eq
            i32.const 16 i32.const 7 call $from i32.const 0 i32.const 7 call $string
            call $reader local.set $r
            local.get $r call $read i32.const 0xd800 call $eq
            local.get $r call $read i32.const 65 call $eq
            local.get $r call $read i32.const 0xdcff call $eq
            local.get $r call $read i32.const -1 call $eq))
