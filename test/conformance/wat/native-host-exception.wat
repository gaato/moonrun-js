;; Ported from moon crates/moonrun/tests/v8_native_imports.rs (host_exception_matches_the_imported_wasm_tag)
(module
        (import "exception" "tag" (tag $tag))
        (import "exception" "throw" (func $throw))
        (func (export "_start")
            (block $caught
                (try_table (catch $tag $caught)
                    call $throw)
                unreachable)))
