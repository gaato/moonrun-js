//! moonrun-cli: upstream's clap definition (`struct Commandline` from main.rs, cut out by
//! build.rs) behind a C ABI. The program name and version are injected (D5).
#![allow(dead_code)]

use std::cell::RefCell;
use std::ffi::OsString;
use std::path::PathBuf;

use clap::{CommandFactory, FromArgMatches};

/// Replaced at run time by `Command::version` (the `#[command(version = ...)]` attribute
/// still needs a function of this name).
fn get_moonrun_version() -> String {
    String::new()
}

include!(concat!(env!("OUT_DIR"), "/commandline.rs"));

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(bytes: Vec<u8>) {
    RESULT.with(|result| *result.borrow_mut() = bytes);
}

#[unsafe(no_mangle)]
pub extern "C" fn cli_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `cli_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cli_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

#[unsafe(no_mangle)]
pub extern "C" fn cli_result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn cli_result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
}

fn os_string(bytes: &[u8]) -> OsString {
    os::unix::ffi::OsStringExt::from_vec(bytes.to_vec())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Parses `argv` (NUL-terminated raw arguments, argv[0] included) with moonrun's clap
/// definition, as `name` with `--version` text `version`. `color` bit 0 / bit 1 enable
/// ANSI styling of messages for stdout / stderr.
///
/// Returns -1 when parsed (result: JSON `{path_hex, args, no_stack_trace, test_args,
/// stack_size, policy_hex, policy_source_dir_hex}`), otherwise clap's exit code with the
/// rendered message as result (stdout for code 0, stderr otherwise).
///
/// # Safety
/// The buffers must come from `cli_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cli_parse(
    argv: *const u8,
    argv_len: usize,
    name: *const u8,
    name_len: usize,
    version: *const u8,
    version_len: usize,
    color: u32,
) -> i32 {
    let raw = unsafe { input(argv, argv_len) };
    let mut args: Vec<OsString> = raw.split(|&b| b == 0).map(os_string).collect();
    // Every entry is NUL-terminated, so the split leaves one empty tail.
    args.pop();
    let name = String::from_utf8_lossy(unsafe { input(name, name_len) }).into_owned();
    let version = String::from_utf8_lossy(unsafe { input(version, version_len) }).into_owned();
    let command = Commandline::command()
        .name(name.clone())
        .bin_name(name)
        .version(version);
    let parsed = command
        .try_get_matches_from(args)
        .and_then(|mut matches| Commandline::from_arg_matches_mut(&mut matches));
    match parsed {
        Ok(c) => {
            let bytes = |p: &PathBuf| hex(p.as_os_str().as_encoded_bytes());
            let out = serde_json::json!({
                "path_hex": bytes(&c.path),
                "args": c.args,
                "no_stack_trace": c.no_stack_trace,
                "test_args": c.test_args,
                "stack_size": c.stack_size,
                "policy_hex": c.policy.as_ref().map(bytes),
                "policy_source_dir_hex": c.policy_source_dir.as_ref().map(bytes),
            });
            set_result(out.to_string().into_bytes());
            -1
        }
        Err(error) => {
            let code = error.exit_code();
            let styled = if code == 0 { color & 1 != 0 } else { color & 2 != 0 };
            let rendered = error.render();
            let text = if styled { rendered.ansi().to_string() } else { rendered.to_string() };
            set_result(text.into_bytes());
            code
        }
    }
}
