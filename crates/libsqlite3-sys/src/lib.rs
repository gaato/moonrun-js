//! Stand-in for the `libsqlite3-sys` crate, for moonrun's `sqlite/policy.rs` compiled into
//! moonrun-policy. SQLite itself is the sqlite-engine component (crates/sqlite-engine); this
//! crate has its constants (SQLite 3.53.2, as libsqlite3-sys 0.38.2 generates them) and an
//! `sqlite3_set_authorizer` that records the callback instead of installing it, so that the
//! component can run upstream's authorizer for the engine (`sqlite_policy_authorize`).
#![allow(non_camel_case_types, non_upper_case_globals)]

use std::cell::Cell;
use std::ffi::{c_char, c_int, c_void};

pub const SQLITE_OK: c_int = 0;
pub const SQLITE_DENY: c_int = 1;
pub const SQLITE_CANTOPEN: c_int = 14;

pub const SQLITE_PRAGMA: c_int = 19;
pub const SQLITE_ATTACH: c_int = 24;
pub const SQLITE_DETACH: c_int = 25;

pub const SQLITE_OPEN_READONLY: c_int = 0x0000_0001;
pub const SQLITE_OPEN_READWRITE: c_int = 0x0000_0002;
pub const SQLITE_OPEN_CREATE: c_int = 0x0000_0004;
pub const SQLITE_OPEN_NOMUTEX: c_int = 0x0000_8000;
pub const SQLITE_OPEN_FULLMUTEX: c_int = 0x0001_0000;

/// An opaque connection; only ever a placeholder here.
pub enum sqlite3 {}

pub type AuthorizerCallback = unsafe extern "C" fn(
    *mut c_void,
    c_int,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
) -> c_int;

thread_local! {
    static AUTHORIZER: Cell<Option<AuthorizerCallback>> = const { Cell::new(None) };
}

/// Records `callback` (the connection and its user data are not kept: upstream installs
/// the same stateless callback with a null context on every connection).
///
/// # Safety
/// Same contract as SQLite's; nothing is dereferenced.
pub unsafe fn sqlite3_set_authorizer(
    _database: *mut sqlite3,
    callback: Option<AuthorizerCallback>,
    _context: *mut c_void,
) -> c_int {
    AUTHORIZER.with(|authorizer| authorizer.set(callback));
    SQLITE_OK
}

/// The callback the last `sqlite3_set_authorizer` recorded.
pub fn recorded_authorizer() -> Option<AuthorizerCallback> {
    AUTHORIZER.with(Cell::get)
}
