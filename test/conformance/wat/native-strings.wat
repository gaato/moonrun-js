;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (strings_preserve_utf16_units_and_builder_snapshots)
(module
        (import "__moonbit_fs_unstable" "begin_create_string" (func $builder (result externref)))
        (import "__moonbit_fs_unstable" "string_append_char" (func $append (param externref i32)))
        (import "__moonbit_fs_unstable" "finish_create_string" (func $finish (param externref) (result externref)))
        (import "__moonbit_fs_unstable" "begin_read_string" (func $reader (param externref) (result externref)))
        (import "__moonbit_fs_unstable" "string_read_char" (func $read (param externref) (result i32)))
        (import "__moonbit_fs_unstable" "finish_read_string" (func $close (param externref)))
        (import "__moonbit_fs_unstable" "jsvalue_is_string" (func $is_string (param externref) (result i32)))
        (func $eq (param i32 i32) local.get 0 local.get 1 i32.ne if unreachable end)
        (func (export "_start") (local $b externref) (local $s externref) (local $r externref)
            call $builder local.set $b
            local.get $b call $is_string i32.const 0 call $eq
            local.get $b call $finish call $reader call $read i32.const -1 call $eq
            local.get $b i32.const 0xd800 call $append
            local.get $b i32.const 0x10041 call $append
            local.get $b i32.const 0xdcff call $append
            local.get $b i32.const 0 call $append
            local.get $b call $finish local.set $s
            local.get $s call $is_string i32.const 1 call $eq
            local.get $b i32.const 90 call $append
            local.get $s call $reader local.set $r
            local.get $r call $read i32.const 0xd800 call $eq
            local.get $r call $read i32.const 65 call $eq
            local.get $r call $read i32.const 0xdcff call $eq
            local.get $r call $read i32.const 0 call $eq
            local.get $r call $read i32.const -1 call $eq
            local.get $r call $read i32.const -1 call $eq
            local.get $r call $close
            local.get $r call $read i32.const -1 call $eq))
