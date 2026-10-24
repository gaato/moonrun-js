//! Linux/x86_64 stand-in for the `libc` crate, for upstream `#[cfg(unix)]` code that
//! only reads struct layouts and constants. Functions are host imports (module `libc`)
//! and must not be reachable from shipped components (scripts/build-wasm.ts checks the
//! import list).
#![allow(non_camel_case_types)]

pub type c_int = i32;
pub type c_char = i8;
pub type sa_family_t = u16;
pub type in_port_t = u16;
pub type in_addr_t = u32;

pub const AF_INET: c_int = 2;
pub const AF_INET6: c_int = 10;
pub const STDERR_FILENO: c_int = 2;
pub const ENOSYS: c_int = 38;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct sockaddr {
    pub sa_family: sa_family_t,
    pub sa_data: [c_char; 14],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct in_addr {
    pub s_addr: in_addr_t,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct sockaddr_in {
    pub sin_family: sa_family_t,
    pub sin_port: in_port_t,
    pub sin_addr: in_addr,
    pub sin_zero: [u8; 8],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct in6_addr {
    pub s6_addr: [u8; 16],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct sockaddr_in6 {
    pub sin6_family: sa_family_t,
    pub sin6_port: in_port_t,
    pub sin6_flowinfo: u32,
    pub sin6_addr: in6_addr,
    pub sin6_scope_id: u32,
}

const _: () = assert!(
    core::mem::size_of::<sockaddr>() == 16
        && core::mem::size_of::<sockaddr_in>() == 16
        && core::mem::size_of::<sockaddr_in6>() == 28
);

#[link(wasm_import_module = "libc")]
unsafe extern "C" {
    /// Only reached by stat's console classifier, absent from stat_pack's call tree.
    pub fn isatty(fd: c_int) -> c_int;
    /// Only for `Env`'s ambient backing, which components never construct.
    pub fn setenv(name: *const c_char, value: *const c_char, overwrite: c_int) -> c_int;
    pub fn unsetenv(name: *const c_char) -> c_int;
}
