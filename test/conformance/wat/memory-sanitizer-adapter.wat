;; Ported from moon crates/moonrun/tests/test.rs (engine_backends_share_the_memory_sanitizer_adapter)
(module
            (import "moonbit:ffi/memory-sanitizer" "register-object-alloc"
                (func $alloc (param i32 i32)))
            (import "moonbit:ffi/memory-sanitizer" "register-object-free"
                (func $free (param i32)))
            (import "moonbit:ffi/memory-sanitizer" "object-is-valid"
                (func $valid (param i32) (result i32)))
            (func (export "_start")
                i32.const 16
                i32.const 32
                call $alloc
                i32.const 32
                call $valid
                i32.eqz
                if unreachable end
                i32.const 32
                call $free
                i32.const 32
                call $valid
                if unreachable end))
