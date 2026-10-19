//! C ABI of moonrun-policy (the tls-engine style: inputs copied in through
//! `policy_alloc`, the variable-size result read through `policy_result_ptr`/`_len`,
//! state kept in this instance). Error chains are JSON arrays of strings, outermost
//! context first. Authorization results are `AsyncHostError` codes: 0 allowed,
//! 1 Fault, 2 Inval, 3 Io, 4 Badf, 5 PermissionDenied, 6 Native.
//!
//! Lengths of `usize::MAX` mean "absent" where an argument is optional.

use std::cell::RefCell;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;

use crate::async_host::{AsyncHostError, AsyncHostResult};
use crate::filesystem::{FsOperationResults, HostFs, HostFsError, Job};
use crate::os::unix::ffi::OsStrExt;
use crate::policy::{self, NetOperation, NetPolicy, ProcessPolicy, SocketRule};
use crate::runtime::{Env, EnvProvisioning, WorkingDirectory};

const ABSENT: usize = usize::MAX;
/// A Resource that is a file but has no canonical path (`Resource::canonical_path` None).
const NO_CANONICAL_PATH: usize = usize::MAX - 1;

struct Run {
    filesystem: HostFs,
    environment: Arc<Env>,
    net: Option<NetPolicy>,
    process: Option<ProcessPolicy>,
    resolved: Vec<SocketRule>,
    inheritance: Option<Vec<u8>>,
    results: FsOperationResults,
}

thread_local! {
    static RUN: RefCell<Option<Run>> = const { RefCell::new(None) };
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(bytes: Vec<u8>) {
    RESULT.with(|result| *result.borrow_mut() = bytes);
}

fn with_run<R>(f: impl FnOnce(&mut Run) -> R) -> R {
    RUN.with(|run| match run.borrow_mut().as_mut() {
        Some(run) => f(run),
        None => panic!("moonrun-policy: no run (call policy_load_* or policy_init_ambient first)"),
    })
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
}

unsafe fn os_input<'a>(ptr: *const u8, len: usize) -> &'a OsStr {
    OsStr::from_bytes(unsafe { input(ptr, len) })
}

unsafe fn optional_os<'a>(ptr: *const u8, len: usize) -> Option<&'a OsStr> {
    (len != ABSENT).then(|| unsafe { os_input(ptr, len) })
}

/// The guest strings these imports receive are `string_lossy` values (always UTF-8).
unsafe fn str_input<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(unsafe { input(ptr, len) }).unwrap_or_default()
}

fn host_code(result: AsyncHostResult<()>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(AsyncHostError::Fault) => 1,
        Err(AsyncHostError::Inval) => 2,
        Err(AsyncHostError::Io) => 3,
        Err(AsyncHostError::Badf) => 4,
        Err(AsyncHostError::PermissionDenied) => 5,
        Err(AsyncHostError::Native(_)) => 6,
    }
}

fn chain(error: &anyhow::Error) -> Vec<u8> {
    let chain: Vec<String> = error.chain().map(ToString::to_string).collect();
    serde_json::to_vec(&chain).unwrap_or_default()
}

#[unsafe(no_mangle)]
pub extern "C" fn policy_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

#[unsafe(no_mangle)]
pub extern "C" fn policy_result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn policy_result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

// ----- construction (moonrun `Runtime::new`) -----

fn install(loaded: anyhow::Result<(policy::Policy, EnvProvisioning)>) -> i32 {
    // runtime/mod.rs:157-160 realizes the environment under this context.
    let realized = loaded.and_then(|(policy, provisioning)| {
        let environment = provisioning
            .realize()
            .context("failed to construct the Runtime environment")?;
        Ok((policy, environment))
    });
    match realized {
        Ok((mut policy, environment)) => {
            let inheritance = policy
                .take_policy_inheritance()
                .and_then(|inheritance| inheritance.open_transfer().ok())
                .and_then(|transfer| transfer.read().ok());
            let environment = Arc::new(environment);
            let filesystem = HostFs::new(
                policy.take_filesystem_policy(),
                Arc::clone(&environment),
                Arc::new(WorkingDirectory::Ambient),
            );
            RUN.with(|run| {
                *run.borrow_mut() = Some(Run {
                    filesystem,
                    environment,
                    net: policy.take_network_policy(),
                    process: policy.take_process_policy(),
                    resolved: Vec::new(),
                    inheritance,
                    results: FsOperationResults::default(),
                });
            });
            set_result(Vec::new());
            0
        }
        Err(error) => {
            set_result(chain(&error));
            1
        }
    }
}

/// `--policy PATH [--policy-source-dir DIR]` (`dir_len` ABSENT without the option).
/// 0 = loaded; 1 = failed, result = the error chain (runtime/mod.rs's context first).
///
/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_load_file(path: *const u8, path_len: usize, dir: *const u8, dir_len: usize) -> i32 {
    let path = Path::new(unsafe { os_input(path, path_len) });
    let dir = unsafe { optional_os(dir, dir_len) }.map(Path::new);
    install(policy::load_file_with_source_dir(path, dir).context(
        "failed to load sandbox policy (experimental); run `moonrun --help` for policy format notes",
    ))
}

/// The contents of the `MOONRUN_INHERITED_POLICY` descriptor.
///
/// # Safety
/// The buffer must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_load_inherited(contents: *const u8, len: usize) -> i32 {
    install(
        policy::load_inherited_json(unsafe { input(contents, len) })
            .context("failed to load inherited sandbox policy (experimental)"),
    )
}

/// No policy: the Host Filesystem over the ambient environment, nothing is checked.
#[unsafe(no_mangle)]
pub extern "C" fn policy_init_ambient() {
    let environment = Arc::new(Env::ambient());
    RUN.with(|run| {
        *run.borrow_mut() = Some(Run {
            filesystem: HostFs::new(None, Arc::clone(&environment), Arc::new(WorkingDirectory::Ambient)),
            environment,
            net: None,
            process: None,
            resolved: Vec::new(),
            inheritance: None,
            results: FsOperationResults::default(),
        });
    });
}

/// The payload a child moonrun receives (result). 0 = present, 1 = no policy.
#[unsafe(no_mangle)]
pub extern "C" fn policy_inheritance() -> i32 {
    with_run(|run| match &run.inheritance {
        Some(bytes) => {
            set_result(bytes.clone());
            0
        }
        None => 1,
    })
}

// ----- the Run's environment (`Env`) -----

/// Result: NUL-terminated `name=value` entries (`Env::entries`).
#[unsafe(no_mangle)]
pub extern "C" fn env_entries() {
    let entries = with_run(|run| run.environment.entries());
    let mut out = Vec::new();
    for (name, value) in entries {
        out.extend_from_slice(name.as_bytes());
        out.push(b'=');
        out.extend_from_slice(value.as_bytes());
        out.push(0);
    }
    set_result(out);
}

/// `Env::get`: 1 with the value as result, 0 when unset.
///
/// # Safety
/// The buffer must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn env_get(name: *const u8, len: usize) -> i32 {
    let name = unsafe { os_input(name, len) };
    match with_run(|run| run.environment.get(name)) {
        Some(value) => {
            set_result(value.as_bytes().to_vec());
            1
        }
        None => 0,
    }
}

/// `Env::set`: 0, or 1 with the `EnvError` text as result.
///
/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn env_set(name: *const u8, name_len: usize, value: *const u8, value_len: usize) -> i32 {
    let name = unsafe { os_input(name, name_len) }.to_owned();
    let value = unsafe { os_input(value, value_len) }.to_owned();
    match with_run(|run| run.environment.set(name, value)) {
        Ok(()) => 0,
        Err(error) => {
            set_result(error.to_string().into_bytes());
            1
        }
    }
}

/// `Env::unset`: 0, or 1 with the `EnvError` text as result.
///
/// # Safety
/// The buffer must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn env_unset(name: *const u8, len: usize) -> i32 {
    let name = unsafe { os_input(name, len) };
    match with_run(|run| run.environment.unset(name)) {
        Ok(()) => 0,
        Err(error) => {
            set_result(error.to_string().into_bytes());
            1
        }
    }
}

// ----- Host Filesystem: the `__moonbit_fs_unstable` operations -----

/// The legacy (panicking) operations: 0 = ok (value as result where there is one),
/// 1 = failed (result = the `HostFsError` text the import panics with).
fn legacy<T>(result: Result<T, HostFsError>, value: impl FnOnce(T) -> Vec<u8>) -> i32 {
    match result {
        Ok(v) => {
            set_result(value(v));
            0
        }
        Err(error) => {
            set_result(error.to_string().into_bytes());
            1
        }
    }
}

fn nothing(_: ()) -> Vec<u8> {
    Vec::new()
}

fn names(files: Vec<String>) -> Vec<u8> {
    let mut out = Vec::new();
    for file in files {
        out.extend_from_slice(file.as_bytes());
        out.push(0);
    }
    out
}

macro_rules! path_export {
    ($(#[$doc:meta])* $name:ident, |$fs:ident, $path:ident| $body:expr) => {
        $(#[$doc])*
        /// # Safety
        /// The buffer must come from `policy_alloc`.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(path: *const u8, path_len: usize) -> i32 {
            let $path = unsafe { str_input(path, path_len) };
            with_run(|run| {
                let $fs = run;
                $body
            })
        }
    };
}

path_export!(hostfs_read_file_to_string, |run, path| legacy(
    run.filesystem.read_file_to_string(path),
    String::into_bytes
));
path_export!(hostfs_create_dir, |run, path| legacy(run.filesystem.create_dir(path), nothing));
path_export!(
    /// Result: NUL-terminated names.
    hostfs_read_dir,
    |run, path| legacy(run.filesystem.read_dir(path), names)
);
path_export!(hostfs_is_file, |run, path| i32::from(run.filesystem.is_file(path)));
path_export!(hostfs_is_dir, |run, path| i32::from(run.filesystem.is_dir(path)));
path_export!(hostfs_remove_file, |run, path| legacy(run.filesystem.remove_file(path), nothing));
path_export!(hostfs_remove_dir, |run, path| legacy(run.filesystem.remove_dir(path), nothing));
path_export!(hostfs_path_exists, |run, path| i32::from(run.filesystem.path_exists(path)));

/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hostfs_write_string_to_file(path: *const u8, path_len: usize, data: *const u8, data_len: usize) -> i32 {
    let path = unsafe { str_input(path, path_len) };
    let contents = unsafe { str_input(data, data_len) };
    with_run(|run| legacy(run.filesystem.write_string_to_file(path, contents), nothing))
}

/// The failure of `write_bytes_to_file`: the Host Filesystem's, or the guest value's.
enum WriteBytesError {
    Fs(HostFsError),
    NotBytes,
}

impl From<HostFsError> for WriteBytesError {
    fn from(error: HostFsError) -> Self {
        Self::Fs(error)
    }
}

/// `write_bytes_to_file`: the contents are decoded only after authorization. `data_len`
/// ABSENT means the guest value was not a byte array. 0 ok, 1 failed (result = text),
/// 2 = the value is not a byte array (the import panics with its own unwrap message).
///
/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hostfs_write_bytes_to_file(path: *const u8, path_len: usize, data: *const u8, data_len: usize) -> i32 {
    let path = unsafe { str_input(path, path_len) };
    let result = with_run(|run| {
        run.filesystem.write_bytes_to_file(path, || {
            if data_len == ABSENT {
                Err(WriteBytesError::NotBytes)
            } else {
                Ok(unsafe { input(data, data_len) }.to_vec())
            }
        })
    });
    match result {
        Ok(()) => 0,
        Err(WriteBytesError::Fs(error)) => {
            set_result(error.to_string().into_bytes());
            1
        }
        Err(WriteBytesError::NotBytes) => 2,
    }
}

/// Result: `HostFs::current_dir` (empty when denied).
#[unsafe(no_mangle)]
pub extern "C" fn hostfs_current_dir() {
    let dir = with_run(|run| run.filesystem.current_dir());
    set_result(dir.into_bytes());
}

macro_rules! status_export {
    ($name:ident, $method:ident) => {
        /// Status-code operation; details through the `hostfs_*` getters.
        ///
        /// # Safety
        /// The buffer must come from `policy_alloc`.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(path: *const u8, path_len: usize) -> i32 {
            let path = unsafe { str_input(path, path_len) };
            with_run(|run| run.filesystem.$method(&mut run.results, path))
        }
    };
}

status_export!(hostfs_read_file_to_bytes_new, read_file_to_bytes_new);
status_export!(hostfs_create_dir_new, create_dir_new);
status_export!(hostfs_read_dir_new, read_dir_new);
status_export!(hostfs_is_file_new, is_file_new);
status_export!(hostfs_is_dir_new, is_dir_new);
status_export!(hostfs_remove_file_new, remove_file_new);
status_export!(hostfs_remove_dir_new, remove_dir_new);

/// `write_bytes_to_file_new`; when the guest value is not a byte array, `error` (with
/// `data_len` ABSENT) is the conversion message, reported only after authorization.
///
/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hostfs_write_bytes_to_file_new(
    path: *const u8,
    path_len: usize,
    data: *const u8,
    data_len: usize,
    error: *const u8,
    error_len: usize,
) -> i32 {
    let path = unsafe { str_input(path, path_len) };
    with_run(|run| {
        run.filesystem.write_bytes_to_file_new(&mut run.results, path, || {
            if data_len == ABSENT {
                Err(unsafe { str_input(error, error_len) }.to_owned())
            } else {
                Ok(unsafe { input(data, data_len) }.to_vec())
            }
        })
    })
}

/// Result: the last file content.
#[unsafe(no_mangle)]
pub extern "C" fn hostfs_file_content() {
    set_result(with_run(|run| run.results.file_content().to_vec()));
}

/// Result: the last directory listing, NUL-terminated names.
#[unsafe(no_mangle)]
pub extern "C" fn hostfs_dir_files() {
    set_result(with_run(|run| names(run.results.dir_files().to_vec())));
}

/// Result: the last error message.
#[unsafe(no_mangle)]
pub extern "C" fn hostfs_error_message() {
    set_result(with_run(|run| run.results.error_message().as_bytes().to_vec()));
}

// ----- Host Filesystem authorization for the async Filesystem Jobs -----

/// `resource_len`: ABSENT = the handle is not a file Resource; NO_CANONICAL_PATH = a file
/// without a canonical path; otherwise the canonical path recorded at open.
unsafe fn resource_path(ptr: *const u8, len: usize) -> Option<Option<PathBuf>> {
    match len {
        ABSENT => None,
        NO_CANONICAL_PATH => Some(None),
        _ => Some(Some(PathBuf::from(unsafe { os_input(ptr, len) }))),
    }
}

/// `Job::check_policy` (see the `filesystem/job` stub). `kind`:
/// 0 open(path, access=a, create_mode=b, append=c, stat mask=d),
/// 1 fstatx / file_size / file_time(resource),
/// 2 statx / file_kind_by_path(parent = resource when a != 0, path, follow=b),
/// 3 file_time_by_path(path, follow=b), 4 realpath / inotify_add_watch(path),
/// 5 access(path, a), 6 chmod(path), 7 flock(resource, exclusive=a), 8 remove(path),
/// 9 rename(path, path2), 10 symlink / mkdir / rmdir(path), other: unchecked.
///
/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_check_job(
    kind: i32,
    a: i32,
    b: i32,
    c: i32,
    d: u32,
    path: *const u8,
    path_len: usize,
    path2: *const u8,
    path2_len: usize,
    resource: *const u8,
    resource_len: usize,
) -> i32 {
    let path = || unsafe { os_input(path, path_len) }.to_owned();
    let file = || unsafe { resource_path(resource, resource_len) };
    let job = match kind {
        0 => Job::open(path(), a, b, c != 0, d),
        1 => Job::file_metadata(file()),
        2 => Job::stat_path((a != 0).then(|| file().flatten()), path(), b != 0),
        3 => Job::file_time_by_path(path(), b != 0),
        4 => Job::path_metadata(path()),
        5 => Job::access(path(), a),
        6 => Job::chmod(path()),
        7 => Job::flock(file(), a != 0),
        8 => Job::remove(path()),
        9 => Job::rename(path(), unsafe { os_input(path2, path2_len) }.to_owned()),
        10 => Job::write_entry(path()),
        _ => Job::unchecked(),
    };
    with_run(|run| host_code(job.check_policy(&run.filesystem)))
}

/// `HostFs::authorize_read` (TLS key/certificate files, SQLite databases).
///
/// # Safety
/// The buffer must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_authorize_read(path: *const u8, len: usize) -> i32 {
    let path = unsafe { os_input(path, len) };
    with_run(|run| host_code(run.filesystem.authorize_read(path)))
}

/// `HostFs::authorize_write`.
///
/// # Safety
/// The buffer must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_authorize_write(path: *const u8, len: usize) -> i32 {
    let path = unsafe { os_input(path, len) };
    with_run(|run| host_code(run.filesystem.authorize_write(path)))
}

// ----- SQLite (sqlite/policy.rs) -----

/// moonrun `open_database`'s admission: `normalize_open_flags`, then `ensure_valid_database`
/// with the normalized flags. `vfs` is the guest's u64 split into halves. Returns the
/// normalized flags, or the SQLite result code negated.
///
/// # Safety
/// The buffer must come from `policy_alloc`; it holds the filename without its NUL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_sqlite_admit(filename: *const u8, len: usize, flags: i32, vfs_low: u32, vfs_high: u32) -> i32 {
    let Ok(filename) = std::ffi::CString::new(unsafe { input(filename, len) }) else {
        return -libsqlite3_sys::SQLITE_CANTOPEN;
    };
    let vfs = (u64::from(vfs_high) << 32) | u64::from(vfs_low);
    let flags = crate::sqlite_policy::normalize_open_flags(flags);
    with_run(|run| match crate::sqlite_policy::ensure_valid_database(&run.filesystem, &filename, flags, vfs) {
        Ok(()) => flags,
        Err(code) => -code,
    })
}

/// Upstream `untrusted_authorizer` for one authorizer call of the engine. Each string is
/// absent (`len == usize::MAX`) for a NULL argument.
///
/// # Safety
/// The buffers must come from `policy_alloc`; they hold the strings without their NUL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_sqlite_authorize(
    action: i32,
    argument1: *const u8,
    argument1_len: usize,
    argument2: *const u8,
    argument2_len: usize,
    database: *const u8,
    database_len: usize,
    trigger: *const u8,
    trigger_len: usize,
) -> i32 {
    if libsqlite3_sys::recorded_authorizer().is_none() {
        // Upstream installs the authorizer per connection; the stand-in records it.
        crate::sqlite_policy::install_authorizer(std::ptr::NonNull::dangling());
    }
    let Some(authorizer) = libsqlite3_sys::recorded_authorizer() else {
        return libsqlite3_sys::SQLITE_DENY;
    };
    let text = |ptr: *const u8, len: usize| {
        (len != ABSENT).then(|| std::ffi::CString::new(unsafe { input(ptr, len) }).unwrap_or_default())
    };
    let arguments = [
        text(argument1, argument1_len),
        text(argument2, argument2_len),
        text(database, database_len),
        text(trigger, trigger_len),
    ];
    let pointer = |i: usize| arguments[i].as_ref().map_or(std::ptr::null(), |s| s.as_ptr());
    unsafe { authorizer(std::ptr::null_mut(), action, pointer(0), pointer(1), pointer(2), pointer(3)) }
}

// ----- network and process -----

/// 1 when a network policy is enforced (moonrun builds `HostNetwork` checks only then).
#[unsafe(no_mangle)]
pub extern "C" fn policy_has_net() -> i32 {
    with_run(|run| i32::from(run.net.is_some()))
}

/// 1 when a process policy is enforced.
#[unsafe(no_mangle)]
pub extern "C" fn policy_has_process() -> i32 {
    with_run(|run| i32::from(run.process.is_some()))
}

/// `NetPolicy::check_dns`.
///
/// # Safety
/// The buffer must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_check_dns(host: *const u8, len: usize) -> i32 {
    let host = unsafe { os_input(host, len) };
    with_run(|run| run.net.as_ref().map_or(0, |net| host_code(net.check_dns(host))))
}

/// After a getaddrinfo result was fetched: `addresses` is a sequence of
/// (u32 little-endian length, Linux sockaddr) records (`resolved_connect_rules`).
///
/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_record_resolved(host: *const u8, host_len: usize, addresses: *const u8, addresses_len: usize) -> i32 {
    let host = unsafe { os_input(host, host_len) };
    let mut rest = unsafe { input(addresses, addresses_len) };
    let mut list = Vec::new();
    while let Some((len, tail)) = rest.split_first_chunk::<4>() {
        let len = u32::from_le_bytes(*len) as usize;
        let Some(address) = tail.get(..len) else { break };
        list.push(Box::<[u8]>::from(address));
        rest = &tail[len..];
    }
    with_run(|run| {
        let Some(net) = run.net.as_ref() else { return 0 };
        match net.resolved_connect_rules(host, &list) {
            Ok(rules) => {
                run.resolved.extend(rules);
                0
            }
            Err(error) => host_code(Err(error)),
        }
    })
}

/// `NetPolicy::check_socket`; `op` 0 connect, 1 bind; `address` is a Linux sockaddr.
///
/// # Safety
/// The buffer must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_check_socket(op: i32, address: *const u8, len: usize) -> i32 {
    let address = unsafe { input(address, len) };
    let operation = if op == 0 { NetOperation::Connect } else { NetOperation::Bind };
    with_run(|run| {
        run.net
            .as_ref()
            .map_or(0, |net| host_code(net.check_socket(operation, address, &run.resolved)))
    })
}

/// `ProcessPolicy::allows_unix`; `argv` is NUL-terminated entries (argv[0] included).
///
/// # Safety
/// The buffers must come from `policy_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn policy_check_spawn(program: *const u8, program_len: usize, argv: *const u8, argv_len: usize) -> i32 {
    let program = unsafe { os_input(program, program_len) };
    let mut argv: Vec<OsString> = unsafe { input(argv, argv_len) }
        .split(|&b| b == 0)
        .map(|arg| OsStr::from_bytes(arg).to_owned())
        .collect();
    argv.pop();
    with_run(|run| {
        run.process
            .as_ref()
            .map_or(0, |process| host_code(process.allows_unix(program, &argv)))
    })
}
