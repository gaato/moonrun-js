//! moonrun-diag: upstream `source_map.rs`, `wasm_diagnostic.rs`, `memory_sanitizer.rs`
//! and moonutil's `demangle.rs`, verbatim, behind a C ABI in the style of tls-engine:
//! inputs are copied in through `diag_alloc`, variable-size results are read through
//! `diag_result_ptr`/`diag_result_len`. Host imports: `host.read_file` (the source map
//! file) and `host.strerror` (from the `os` crate).
#![allow(dead_code)]

pub(crate) use ::os;

#[path = "../upstream/crates/moonrun/src/source_map.rs"]
mod source_map;
#[path = "../upstream/crates/moonrun/src/wasm_diagnostic.rs"]
mod wasm_diagnostic;
#[path = "../upstream/crates/moonrun/src/memory_sanitizer.rs"]
mod memory_sanitizer;

use std::cell::RefCell;
use std::path::Path;

use memory_sanitizer::{MemorySanitizer, SanitizerStack, SanitizerStackFrame};
use wasm_diagnostic::DiagnosticLine;

/// Numbered slots (id 0 = none), as in tls-engine.
struct Slots<T> {
    items: Vec<Option<T>>,
}

impl<T> Slots<T> {
    const fn new() -> Self {
        Self { items: Vec::new() }
    }

    fn insert(&mut self, value: T) -> u32 {
        let index = match self.items.iter().position(Option::is_none) {
            Some(index) => {
                self.items[index] = Some(value);
                index
            }
            None => {
                self.items.push(Some(value));
                self.items.len() - 1
            }
        };
        u32::try_from(index + 1).unwrap_or(0)
    }

    fn get(&self, id: u32) -> Option<&T> {
        self.items.get((id as usize).wrapping_sub(1)).and_then(Option::as_ref)
    }

    fn remove(&mut self, id: u32) {
        if let Some(slot) = self.items.get_mut((id as usize).wrapping_sub(1)) {
            *slot = None;
        }
    }
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static MAPS: RefCell<Slots<source_map::SourceMap>> = const { RefCell::new(Slots::new()) };
    static SANITIZERS: RefCell<Slots<MemorySanitizer>> = const { RefCell::new(Slots::new()) };
}

fn set_result(bytes: Vec<u8>) {
    RESULT.with(|result| *result.borrow_mut() = bytes);
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
}

unsafe fn input_str<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(unsafe { input(ptr, len) }).unwrap_or("")
}

#[unsafe(no_mangle)]
pub extern "C" fn diag_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `diag_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diag_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

#[unsafe(no_mangle)]
pub extern "C" fn diag_result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn diag_result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

/// `source_map::load(wasm_path, wasm)`. Returns a map id, 0 when there is none.
///
/// # Safety
/// The arguments must be buffers from `diag_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diag_source_map_load(
    path: *const u8,
    path_len: usize,
    wasm: *const u8,
    wasm_len: usize,
) -> u32 {
    let path = os::unix::ffi::OsStrExt::from_bytes(unsafe { input(path, path_len) });
    match source_map::load(Path::new::<std::ffi::OsStr>(path), unsafe { input(wasm, wasm_len) }) {
        Some(map) => MAPS.with(|maps| maps.borrow_mut().insert(map)),
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn diag_source_map_free(id: u32) {
    MAPS.with(|maps| maps.borrow_mut().remove(id));
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Line {
    Text(String),
    Frame { indentation: String, function: String, offset: Option<usize>, location: Option<String> },
}

/// `wasm_diagnostic::render`. `lines` is a JSON array of strings (text lines) and
/// `{indentation, function, offset}` objects (frames). Result: the rendered text.
///
/// # Safety
/// `lines` must be a buffer from `diag_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diag_render(lines: *const u8, lines_len: usize, map: u32, no_stack_trace: i32) -> i32 {
    let Ok(lines) = serde_json::from_slice::<Vec<Line>>(unsafe { input(lines, lines_len) }) else {
        return -1;
    };
    let lines = lines.into_iter().map(|line| match line {
        Line::Text(text) => DiagnosticLine::Text(text),
        Line::Frame { indentation, function, offset, location } => DiagnosticLine::Frame {
            indentation,
            function,
            runtime_location: location,
            module_offset: offset,
        },
    });
    let rendered = MAPS.with(|maps| wasm_diagnostic::render(lines, maps.borrow().get(map), no_stack_trace != 0));
    set_result(rendered.into_bytes());
    0
}

/// moonutil `demangle_mangled_function_name`. Result: the demangled name.
///
/// # Safety
/// `name` must be a buffer from `diag_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diag_demangle(name: *const u8, len: usize) {
    let name = unsafe { input_str(name, len) };
    set_result(moonutil::demangle::demangle_mangled_function_name(name).into_bytes());
}

/// A memory sanitizer for one run (`moonbit:ffi/memory-sanitizer`).
#[unsafe(no_mangle)]
pub extern "C" fn diag_sanitizer_new() -> u32 {
    SANITIZERS.with(|s| s.borrow_mut().insert(MemorySanitizer::default()))
}

#[unsafe(no_mangle)]
pub extern "C" fn diag_sanitizer_free(id: u32) {
    SANITIZERS.with(|s| s.borrow_mut().remove(id));
}

fn with_sanitizer<R>(id: u32, f: impl FnOnce(&MemorySanitizer) -> R) -> R {
    SANITIZERS.with(|s| match s.borrow().get(id) {
        Some(sanitizer) => f(sanitizer),
        None => panic!("unknown sanitizer"),
    })
}

/// `register_object_alloc`; `frames` are the raw names of the guest (wasm) frames,
/// NUL-terminated, innermost first. 0 = ok, 1 = error (result = its Display).
///
/// # Safety
/// `frames` must be a buffer from `diag_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diag_sanitizer_alloc(id: u32, size: u32, ptr: u32, frames: *const u8, frames_len: usize) -> i32 {
    let frames = unsafe { input(frames, frames_len) };
    let result = with_sanitizer(id, |sanitizer| {
        sanitizer.register_object_alloc(size, ptr, || {
            SanitizerStack::new(
                frames
                    .split(|&b| b == 0)
                    .filter(|frame| !frame.is_empty())
                    .map(|frame| SanitizerStackFrame::new(String::from_utf8_lossy(frame).into_owned(), true))
                    .collect(),
            )
        })
    });
    match result {
        Ok(()) => 0,
        Err(error) => {
            set_result(error.to_string().into_bytes());
            1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn diag_sanitizer_free_object(id: u32, ptr: u32) -> i32 {
    match with_sanitizer(id, |sanitizer| sanitizer.register_object_free(ptr)) {
        Ok(()) => 0,
        Err(error) => {
            set_result(error.to_string().into_bytes());
            1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn diag_sanitizer_is_valid(id: u32, ptr: u32) -> i32 {
    i32::from(with_sanitizer(id, |sanitizer| sanitizer.object_is_valid(ptr)))
}

/// `check_for_leaks`: 0 = none, 1 = leaks (result = the report).
#[unsafe(no_mangle)]
pub extern "C" fn diag_sanitizer_check_leaks(id: u32) -> i32 {
    match with_sanitizer(id, MemorySanitizer::check_for_leaks) {
        Ok(()) => 0,
        Err(error) => {
            set_result(error.to_string().into_bytes());
            1
        }
    }
}
