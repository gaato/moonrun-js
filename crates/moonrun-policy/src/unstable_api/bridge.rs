//! The `__moonbit_fs_unstable` operations for `abi.rs` (moonrun-js, not upstream).
//!
//! Upstream `unstable_api/filesystem.rs` keeps its presentation `pub(super)` to
//! `unstable_api`; as a child of that module this file re-exposes exactly what moonrun's
//! `unstable_api.rs` imports call, with the error text each import reports.

use super::filesystem::{FsOperationResults, UnstableFs, UnstableFsError};
use crate::filesystem::HostFs;

/// Results retained between an operation and its getter (`FsOperationResults`).
#[derive(Default)]
pub(crate) struct Results(FsOperationResults);

impl Results {
    pub(crate) fn file_content(&self) -> &[u8] {
        self.0.file_content()
    }

    pub(crate) fn dir_files(&self) -> &[String] {
        self.0.dir_files()
    }

    pub(crate) fn error_message(&self) -> &str {
        self.0.error_message()
    }
}

fn text(error: UnstableFsError) -> String {
    error.to_string()
}

pub(crate) fn read_file_to_string(fs: &HostFs, path: &str) -> Result<String, String> {
    UnstableFs(fs).read_file_to_string(path).map_err(text)
}

pub(crate) fn write_string_to_file(fs: &HostFs, path: &str, contents: &str) -> Result<(), String> {
    UnstableFs(fs).write_string_to_file(path, contents).map_err(text)
}

pub(crate) fn create_dir(fs: &HostFs, path: &str) -> Result<(), String> {
    UnstableFs(fs).create_dir(path).map_err(text)
}

pub(crate) fn read_dir(fs: &HostFs, path: &str) -> Result<Vec<String>, String> {
    UnstableFs(fs).read_dir(path).map_err(text)
}

pub(crate) fn is_file(fs: &HostFs, path: &str) -> bool {
    UnstableFs(fs).is_file(path)
}

pub(crate) fn is_dir(fs: &HostFs, path: &str) -> bool {
    UnstableFs(fs).is_dir(path)
}

pub(crate) fn remove_file(fs: &HostFs, path: &str) -> Result<(), String> {
    UnstableFs(fs).remove_file(path).map_err(text)
}

pub(crate) fn remove_dir(fs: &HostFs, path: &str) -> Result<(), String> {
    UnstableFs(fs).remove_dir(path).map_err(text)
}

pub(crate) fn path_exists(fs: &HostFs, path: &str) -> bool {
    UnstableFs(fs).path_exists(path)
}

pub(crate) fn current_dir(fs: &HostFs) -> String {
    UnstableFs(fs).current_dir()
}

/// The failure of `write_bytes_to_file`: the Host Filesystem's text, or the guest value
/// was not a byte array (the import then panics with its own unwrap message).
pub(crate) enum WriteBytesError {
    Fs(String),
    NotBytes,
}

impl From<UnstableFsError> for WriteBytesError {
    fn from(error: UnstableFsError) -> Self {
        Self::Fs(error.to_string())
    }
}

/// The contents are decoded only after authorization (`None`: not a byte array).
pub(crate) fn write_bytes_to_file(
    fs: &HostFs,
    path: &str,
    contents: impl FnOnce() -> Option<Vec<u8>>,
) -> Result<(), WriteBytesError> {
    UnstableFs(fs).write_bytes_to_file(path, || contents().ok_or(WriteBytesError::NotBytes))
}

pub(crate) fn read_file_to_bytes_new(fs: &HostFs, results: &mut Results, path: &str) -> i32 {
    UnstableFs(fs).read_file_to_bytes_new(&mut results.0, path)
}

pub(crate) fn write_bytes_to_file_new(
    fs: &HostFs,
    results: &mut Results,
    path: &str,
    contents: impl FnOnce() -> Result<Vec<u8>, String>,
) -> i32 {
    UnstableFs(fs).write_bytes_to_file_new(&mut results.0, path, contents)
}

pub(crate) fn create_dir_new(fs: &HostFs, results: &mut Results, path: &str) -> i32 {
    UnstableFs(fs).create_dir_new(&mut results.0, path)
}

pub(crate) fn read_dir_new(fs: &HostFs, results: &mut Results, path: &str) -> i32 {
    UnstableFs(fs).read_dir_new(&mut results.0, path)
}

pub(crate) fn is_file_new(fs: &HostFs, results: &mut Results, path: &str) -> i32 {
    UnstableFs(fs).is_file_new(&mut results.0, path)
}

pub(crate) fn is_dir_new(fs: &HostFs, results: &mut Results, path: &str) -> i32 {
    UnstableFs(fs).is_dir_new(&mut results.0, path)
}

pub(crate) fn remove_file_new(fs: &HostFs, results: &mut Results, path: &str) -> i32 {
    UnstableFs(fs).remove_file_new(&mut results.0, path)
}

pub(crate) fn remove_dir_new(fs: &HostFs, results: &mut Results, path: &str) -> i32 {
    UnstableFs(fs).remove_dir_new(&mut results.0, path)
}
