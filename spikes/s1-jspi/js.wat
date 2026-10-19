(module
  (import "wasm:js-string" "length" (func $len (param externref) (result i32)))
  (import "_" "hello" (global $h (ref extern)))
  (import "_" "a\u{e9}" (global $h2 (ref extern)))
  (func (export "f") (result i32) (call $len (global.get $h)))
  (func (export "g") (result externref) (global.get $h2)))
