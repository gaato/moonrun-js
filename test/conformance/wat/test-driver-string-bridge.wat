;; Ported from moon crates/moonrun/tests/engine_backends.rs (engine_backends_support_test_driver_string_bridge)
(module
                    (import "__moonbit_fs_unstable" "begin_read_string"
                        (func $begin_read_string (param externref) (result externref)))
                    (import "__moonbit_fs_unstable" "string_read_char"
                        (func $string_read_char (param externref) (result i32)))
                    (import "__moonbit_fs_unstable" "finish_read_string"
                        (func $finish_read_string (param externref)))
                    (func (export "moonbit_test_driver_internal_execute")
                        (param $file externref) (param i32)
                        (local $reader externref)
                        (local $length i32)
                        local.get $file
                        call $begin_read_string
                        local.set $reader

                        local.get $reader
                        call $string_read_char
                        i32.const 109
                        i32.ne
                        if unreachable end
                        i32.const 1
                        local.set $length

                        block $done
                            loop $next
                                local.get $reader
                                call $string_read_char
                                i32.const -1
                                i32.eq
                                br_if $done
                                local.get $length
                                i32.const 1
                                i32.add
                                local.set $length
                                br $next
                            end
                        end
                        local.get $reader
                        call $finish_read_string

                        local.get $length
                        i32.const 13
                        i32.ne
                        if unreachable end)
                    (func (export "moonbit_test_driver_finish")))
