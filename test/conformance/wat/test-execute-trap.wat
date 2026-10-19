;; Ported from moon crates/moonrun/tests/engine_outcomes.rs (engine_backend_keeps_handled_test_failures_inside_the_test_driver)
(module
            (func (export "moonbit_test_driver_internal_execute")
                (param externref i32)
                unreachable)
            (func (export "moonbit_test_driver_finish")))
