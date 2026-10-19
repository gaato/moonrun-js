;; Ported from moon crates/moonrun/tests/engine_outcomes.rs (engine_backend_classifies_uncaught_wasm_failures_as_guest_failures)
(module
                (import "exception" "tag" (tag $tag))
                (import "exception" "throw" (func $throw))
                (func (export "_start") call $throw))
