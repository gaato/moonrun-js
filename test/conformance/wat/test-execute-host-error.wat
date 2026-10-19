;; Ported from moon crates/moonrun/tests/engine_outcomes.rs (engine_backend_preserves_host_adapter_errors)
(module
                (import "moonbit:ffi/memory-sanitizer" "register-object-free"
                    (func $free (param i32)))
                (func (export "moonbit_test_driver_internal_execute")
                    (param externref i32)
                    i32.const 1
                    call $free)
                (func (export "moonbit_test_driver_finish")))
