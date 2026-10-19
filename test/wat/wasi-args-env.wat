;; args_*, environ_*, random_get, including EFAULT paths. Prints one number per line.
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get" (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get" (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "random_get" (func $random_get (param i32 i32) (result i32)))
  (memory (export "memory") 1)

  (func $write (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8))))
  (func $num (param $n i32)
    (local $p i32) (local $u i32) (local $neg i32)
    (i32.store8 (i32.const 47) (i32.const 10))
    (local.set $p (i32.const 47))
    (local.set $neg (i32.lt_s (local.get $n) (i32.const 0)))
    (local.set $u (select (i32.sub (i32.const 0) (local.get $n)) (local.get $n) (local.get $neg)))
    (loop $l
      (local.set $p (i32.sub (local.get $p) (i32.const 1)))
      (i32.store8 (local.get $p) (i32.add (i32.const 48) (i32.rem_u (local.get $u) (i32.const 10))))
      (local.set $u (i32.div_u (local.get $u) (i32.const 10)))
      (br_if $l (local.get $u)))
    (if (local.get $neg) (then
      (local.set $p (i32.sub (local.get $p) (i32.const 1)))
      (i32.store8 (local.get $p) (i32.const 45))))
    (call $write (local.get $p) (i32.sub (i32.const 48) (local.get $p))))
  ;; Prints a NUL-terminated string and a newline.
  (func $cstr (param $ptr i32)
    (local $end i32)
    (local.set $end (local.get $ptr))
    (block $done (loop $l
      (br_if $done (i32.eqz (i32.load8_u (local.get $end))))
      (local.set $end (i32.add (local.get $end) (i32.const 1)))
      (br $l)))
    (call $write (local.get $ptr) (i32.sub (local.get $end) (local.get $ptr)))
    (i32.store8 (i32.const 48) (i32.const 10))
    (call $write (i32.const 48) (i32.const 1)))
  ;; Prints `count` strings from a pointer table.
  (func $table (param $ptrs i32) (param $count i32)
    (local $i i32)
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (call $cstr (i32.load (i32.add (local.get $ptrs) (i32.mul (local.get $i) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func (export "_start")
    ;; args
    (call $num (call $args_sizes_get (i32.const 80) (i32.const 84)))
    (call $num (i32.load (i32.const 80)))
    (call $num (i32.load (i32.const 84)))
    (call $num (call $args_get (i32.const 8192) (i32.const 9216)))
    (call $table (i32.const 8192) (i32.load (i32.const 80)))
    ;; environ
    (call $num (call $environ_sizes_get (i32.const 88) (i32.const 92)))
    (call $num (i32.load (i32.const 88)))
    (call $num (i32.load (i32.const 92)))
    (call $num (call $environ_get (i32.const 16384) (i32.const 20480)))
    (call $table (i32.const 16384) (i32.load (i32.const 88)))
    ;; argc write straddling the end of memory
    (call $num (call $args_sizes_get (i32.const 65534) (i32.const 84)))
    ;; argc is written before the size pointer faults
    (i32.store (i32.const 96) (i32.const 777))
    (call $num (call $args_sizes_get (i32.const 96) (i32.const 0xfffffff0)))
    (call $num (i32.load (i32.const 96)))
    ;; the second pointer slot is out of range; the first string was already copied
    (memory.fill (i32.const 12288) (i32.const 0) (i32.const 256))
    (call $num (call $args_get (i32.const 65532) (i32.const 12288)))
    (call $cstr (i32.const 12288))
    (call $num (call $environ_get (i32.const 16384) (i32.const 0xffff0000)))
    (call $num (call $environ_sizes_get (i32.const 0xfffffffc) (i32.const 92)))
    ;; random_get
    (call $num (call $random_get (i32.const 4096) (i32.const 16)))
    (call $num (call $random_get (i32.const 65530) (i32.const 16)))
    (call $num (call $random_get (i32.const 65536) (i32.const 0)))
    (call $num (call $random_get (i32.const 65537) (i32.const 0)))
  )
)
