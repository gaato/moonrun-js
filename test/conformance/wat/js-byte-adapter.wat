;; Ported from moon crates/moonrun/tests/test.rs (engine_backends_share_the_js_byte_adapter)
(module
            (import "ffi-bytes" "memory" (memory 1))
            (import "ffi-bytes" "new"
                (func $new (param i32) (result (ref extern))))
            (import "ffi-bytes" "set"
                (func $set (param externref i32 i32)))
            (import "ffi-bytes" "get"
                (func $get (param externref i32) (result i32)))
            (import "ffi-bytes" "length"
                (func $length (param externref) (result i32)))
            (import "ffi-bytes" "asString"
                (func $as_string (param externref i32 i32) (result (ref extern))))
            (func (export "_start") (local $bytes externref)
                i32.const 4
                call $new
                local.set $bytes
                local.get $bytes i32.const 0 i32.const 300 call $set
                local.get $bytes i32.const 0 call $get
                i32.const 44
                i32.ne
                if unreachable end
                local.get $bytes i32.const 0 i32.const 65 call $set
                local.get $bytes i32.const 1 i32.const 0 call $set
                local.get $bytes i32.const 2 i32.const 66 call $set
                local.get $bytes i32.const 3 i32.const 0 call $set
                local.get $bytes
                call $length
                i32.const 4
                i32.ne
                if unreachable end
                local.get $bytes
                i32.const 0
                i32.const 4
                call $as_string
                drop))
