;; Ported from moon crates/moonrun/tests/engine_outcomes.rs (engine_backend_preserves_host_adapter_errors)
(module
                (import "moonbit:ffi/memory-sanitizer" "register-object-free"
                    (func $free (param i32)))
                (func $module_start i32.const 1 call $free)
                (start $module_start))
