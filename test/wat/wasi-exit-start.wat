;; proc_exit from the start function ends the run before `_start`.
(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func $init (call $proc_exit (i32.const 3)))
  (start $init)
  (func (export "_start") (unreachable)))
