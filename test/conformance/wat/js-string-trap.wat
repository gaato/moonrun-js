;; Ported from moon crates/moonrun/tests/engine_outcomes.rs (engine_backend_classifies_uncaught_wasm_failures_as_guest_failures)
(module
                (import "wasm:js-string" "fromCodePoint"
                    (func $from_code_point (param i32) (result (ref extern))))
                (func (export "_start")
                    i32.const -1
                    call $from_code_point
                    drop))
