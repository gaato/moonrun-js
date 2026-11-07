;; moonrun-js case: a legacy __moonbit_fs_unstable failure is a host error (unstable_api.rs ImportError::Host).
(module
  (import "_" "missing.txt" (global $path (ref extern)))
  (import "__moonbit_fs_unstable" "read_file_to_string" (func $read (param externref) (result externref)))
  (func (export "_start")
    global.get $path
    call $read
    drop))
