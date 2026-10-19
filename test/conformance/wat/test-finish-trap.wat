;; Ported from moon crates/moonrun/tests/engine_outcomes.rs (engine_backend_classifies_uncaught_wasm_failures_as_guest_failures)
(module
                (func (export "moonbit_test_driver_internal_execute")
                    (param externref i32))
                (func (export "moonbit_test_driver_finish") unreachable))
