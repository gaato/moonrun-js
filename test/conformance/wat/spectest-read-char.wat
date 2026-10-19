;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_support_legacy_spectest_read_char)
(module
                (import "spectest" "read_char" (func $read_char (result i32)))
                (import "spectest" "print_char" (func $print_char (param i32)))
                (func (export "_start")
                    call $read_char
                    call $print_char
                    call $read_char
                    i32.const -1
                    i32.ne
                    if unreachable end))
