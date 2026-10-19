;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_share_the_wasip1_adapter)
(module
                (import "wasi_snapshot_preview1" "args_get"
                    (func $args_get (param i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "args_sizes_get"
                    (func $args_sizes_get (param i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "environ_get"
                    (func $environ_get (param i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "environ_sizes_get"
                    (func $environ_sizes_get (param i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "random_get"
                    (func $random_get (param i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_close"
                    (func $fd_close (param i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_prestat_get"
                    (func $fd_prestat_get (param i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_prestat_dir_name"
                    (func $fd_prestat_dir_name (param i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_readdir"
                    (func $fd_readdir (param i32 i32 i32 i64 i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_write"
                    (func $fd_write (param i32 i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "path_open"
                    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "path_readlink"
                    (func $path_readlink (param i32 i32 i32 i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "path_rename"
                    (func $path_rename (param i32 i32 i32 i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "path_create_directory"
                    (func $path_create_directory (param i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "path_remove_directory"
                    (func $path_remove_directory (param i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "path_unlink_file"
                    (func $path_unlink_file (param i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "proc_exit"
                    (func $proc_exit (param i32)))
                (memory (export "memory") 1)
                (data (i32.const 16) "dir")
                (data (i32.const 32) "dir/file.txt")
                (data (i32.const 48) "dir/renamed.txt")
                (data (i32.const 80) "payload")
                (func $ok (param $errno i32)
                    local.get $errno
                    if unreachable end)
                (func (export "_start")
                    i32.const 200 i32.const 204 call $args_sizes_get call $ok
                    i32.const 200 i32.load i32.const 2 i32.ne if unreachable end
                    i32.const 208 i32.const 256 call $args_get call $ok
                    i32.const 300 i32.const 304 call $environ_sizes_get call $ok
                    i32.const 300 i32.load if unreachable end
                    i32.const 8000 i32.const 12000 call $environ_get call $ok
                    i32.const 4096 i32.const 16 call $random_get call $ok

                    i32.const 3 i32.const 4200 call $fd_prestat_get call $ok
                    i32.const 3 i32.const 4210 i32.const 64 call $fd_prestat_dir_name call $ok
                    i32.const 3 i32.const 16 i32.const 3 call $path_create_directory call $ok

                    i32.const 3 i32.const 0 i32.const 32 i32.const 12 i32.const 1
                    i64.const 66 i64.const 0 i32.const 0 i32.const 140 call $path_open call $ok
                    i32.const 128 i32.const 80 i32.store
                    i32.const 132 i32.const 7 i32.store
                    i32.const 140 i32.load i32.const 128 i32.const 1 i32.const 148
                    call $fd_write call $ok
                    i32.const 140 i32.load call $fd_close call $ok

                    i32.const 3 i32.const 32 i32.const 12
                    i32.const 3 i32.const 48 i32.const 15 call $path_rename call $ok
                    i32.const 3 i32.const 0 i32.const 16 i32.const 3 i32.const 2
                    i64.const 16384 i64.const 0 i32.const 0 i32.const 144 call $path_open call $ok
                    i32.const 144 i32.load i32.const 5000 i32.const 1024 i64.const 0 i32.const 152
                    call $fd_readdir call $ok
                    i32.const 152 i32.load i32.eqz if unreachable end
                    i32.const 144 i32.load call $fd_close call $ok

                    i32.const 3 i32.const 48 i32.const 15 call $path_unlink_file call $ok
                    i32.const 3 i32.const 16 i32.const 3 call $path_remove_directory call $ok))
