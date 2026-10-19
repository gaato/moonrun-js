;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_support_js_string_builtins)
(module
                    (type $chars (array (mut i16)))
                    (import "_" "hello" (global $hello (ref extern)))
                    (import "_" " world" (global $world (ref extern)))
                    (import "_" "ell" (global $ell (ref extern)))
                    (import "wasm:js-string" "cast"
                        (func $cast (param externref) (result (ref extern))))
                    (import "wasm:js-string" "test"
                        (func $test (param externref) (result i32)))
                    (import "wasm:js-string" "fromCharCode"
                        (func $from_char_code (param i32) (result (ref extern))))
                    (import "wasm:js-string" "fromCodePoint"
                        (func $from_code_point (param i32) (result (ref extern))))
                    (import "wasm:js-string" "length"
                        (func $length (param externref) (result i32)))
                    (import "wasm:js-string" "charCodeAt"
                        (func $char_code_at (param externref i32) (result i32)))
                    (import "wasm:js-string" "codePointAt"
                        (func $code_point_at (param externref i32) (result i32)))
                    (import "wasm:js-string" "equals"
                        (func $equals (param externref externref) (result i32)))
                    (import "wasm:js-string" "concat"
                        (func $concat (param externref externref) (result (ref extern))))
                    (import "wasm:js-string" "substring"
                        (func $substring (param externref i32 i32) (result (ref extern))))
                    (import "wasm:js-string" "compare"
                        (func $compare (param externref externref) (result i32)))
                    (import "wasm:js-string" "fromCharCodeArray"
                        (func $from_chars
                            (param (ref null $chars) i32 i32)
                            (result (ref extern))))
                    (import "wasm:js-string" "intoCharCodeArray"
                        (func $into_chars
                            (param externref (ref null $chars) i32)
                            (result i32)))
                    (func (export "_start")
                        (local $array (ref $chars))
                        (local $string externref)
                        global.get $hello
                        call $cast
                        call $length
                        i32.const 5
                        i32.ne
                        if unreachable end

                        global.get $hello
                        call $test
                        i32.const 1
                        i32.ne
                        if unreachable end
                        ref.null extern
                        call $test
                        if unreachable end

                        i32.const 65
                        call $from_char_code
                        i32.const 0
                        call $char_code_at
                        i32.const 65
                        i32.ne
                        if unreachable end

                        i32.const 128516
                        call $from_code_point
                        local.set $string
                        local.get $string
                        call $length
                        i32.const 2
                        i32.ne
                        if unreachable end
                        local.get $string
                        i32.const 0
                        call $code_point_at
                        i32.const 128516
                        i32.ne
                        if unreachable end

                        global.get $hello
                        global.get $world
                        call $concat
                        call $length
                        i32.const 11
                        i32.ne
                        if unreachable end

                        global.get $hello
                        i32.const 1
                        call $char_code_at
                        i32.const 101
                        i32.ne
                        if unreachable end

                        global.get $hello
                        i32.const 1
                        i32.const 4
                        call $substring
                        global.get $ell
                        call $equals
                        i32.eqz
                        if unreachable end

                        global.get $hello
                        ref.null extern
                        call $equals
                        if unreachable end
                        ref.null extern
                        ref.null extern
                        call $equals
                        i32.eqz
                        if unreachable end

                        global.get $hello
                        global.get $world
                        call $compare
                        i32.const 1
                        i32.ne
                        if unreachable end

                        i32.const 6
                        array.new_default $chars
                        local.set $array
                        global.get $hello
                        local.get $array
                        i32.const 1
                        call $into_chars
                        i32.const 5
                        i32.ne
                        if unreachable end
                        local.get $array
                        i32.const 1
                        i32.const 6
                        call $from_chars
                        global.get $hello
                        call $equals
                        i32.eqz
                        if unreachable end))
