;; Without an exported memory every memory-using import faults; the result is the exit code.
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory 1)
  (func (export "_start")
    ;; 21 + 8 * 2 = 37
    (call $proc_exit (i32.add (call $args_sizes_get (i32.const 0) (i32.const 4))
      (i32.mul (call $fd_close (i32.const 99)) (i32.const 2))))
    (unreachable)))
