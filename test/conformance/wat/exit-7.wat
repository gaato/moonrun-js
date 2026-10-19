;; Ported from moon crates/moonrun/tests/engine_outcomes.rs (engine_backend_preserves_explicit_run_termination)
(module
            (import "__moonbit_sys_unstable" "exit" (func $exit (param i32)))
            (func (export "_start") i32.const 7 call $exit))
