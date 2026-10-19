;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_support_repeated_imports)
(module
                    (import "__moonbit_sys_unstable" "is_windows"
                        (func $is_windows_a (result i32)))
                    (import "__moonbit_sys_unstable" "is_windows"
                        (func $is_windows_b (result i32)))
                    (func (export "_start")
                        call $is_windows_a
                        call $is_windows_b
                        i32.ne
                        if unreachable end))
