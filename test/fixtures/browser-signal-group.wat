;; A parent that handles SIGINT itself instead of treating it as global cancellation.
;; It spawns cat, waits for its signal status, and consumes the signal notification.
(module
  (import "moonbitlang/async" "event_bus/create" (func $bus (result i64)))
  (import "moonbitlang/async" "thread_pool/init_thread_pool" (func $init (param i64) (result i64)))
  (import "moonbitlang/async" "signal/set_global_cancellation_signals"
    (func $configure (param i32 i32 i32 i32)))
  (import "moonbitlang/async" "signal/start_signal_handler" (func $capture))
  (import "moonbitlang/async" "thread_pool/fetch_completion/unix"
    (func $notifications (param i64 i32 i32) (result i32)))
  (import "moonbitlang/async" "process/make_argv_array/unix" (func $argv (param i32) (result i64)))
  (import "moonbitlang/async" "process/argv_array_add_entry/unix" (func $arg (param i64 i32 i32 i32)))
  (import "moonbitlang/async" "process/make_env" (func $env (param i32) (result i64)))
  (import "moonbitlang/async" "fd_util/invalid_fd" (func $invalid (result i64)))
  (import "moonbitlang/async" "thread_pool/spawn_job/unix"
    (func $spawn (param i32 i32 i64 i64 i64 i64 i64) (result i64)))
  (import "moonbitlang/async" "thread_pool/make_wait_for_process_job"
    (func $wait (param i64 i32) (result i64)))
  (import "moonbitlang/async" "thread_pool/run_job" (func $run (param i64)))
  (import "moonbitlang/async" "thread_pool/job_get_ret" (func $ret (param i64) (result i32)))
  (import "moonbitlang/async" "thread_pool/job_get_err" (func $err (param i64) (result i32)))
  (import "moonbitlang/async" "thread_pool/free_job" (func $free (param i64)))
  (import "spectest" "print_char" (func $char (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "\02\00\00\00") ;; SIGINT, as an array of i32
  (data (i32.const 8) "c\00a\00t\00") ;; UTF-16 guest path and argv[0]
  (data (i32.const 64) "caught SIGINT; child=-2; parent alive\n\00")
  (func (export "_start")
    (local $source i64) (local $args i64) (local $job i64) (local $pid i32)
    (local $ptr i32) (local $c i32)
    (local.set $source (call $init (call $bus)))
    (call $configure (i32.const 0) (i32.const 1) (i32.const 0) (i32.const 1))
    (call $capture)
    (local.set $args (call $argv (i32.const 1)))
    (call $arg (local.get $args) (i32.const 0) (i32.const 8) (i32.const 3))
    (local.set $job (call $spawn (i32.const 8) (i32.const 3) (local.get $args)
      (call $env (i32.const 0)) (call $invalid) (call $invalid) (call $invalid)))
    (call $run (local.get $job))
    (if (call $err (local.get $job)) (then unreachable))
    (local.set $pid (call $ret (local.get $job)))
    (call $free (local.get $job))
    (local.set $job (call $wait (call $invalid) (local.get $pid)))
    (call $run (local.get $job))
    (if (call $err (local.get $job)) (then unreachable))
    (if (i32.ne (call $ret (local.get $job)) (i32.const -2)) (then unreachable))
    (call $free (local.get $job))
    ;; Reading 0x80000002 proves the parent captured SIGINT through the guest ABI.
    (if (i32.ne (call $notifications (local.get $source) (i32.const 16) (i32.const 1))
      (i32.const 4)) (then unreachable))
    (if (i32.ne (i32.load (i32.const 16)) (i32.const 0x80000002)) (then unreachable))
    (local.set $ptr (i32.const 64))
    (block $done (loop $print
      (local.set $c (i32.load8_u (local.get $ptr)))
      (br_if $done (i32.eqz (local.get $c)))
      (call $char (local.get $c))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $print)))))
