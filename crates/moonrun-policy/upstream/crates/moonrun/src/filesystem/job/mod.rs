//! STUB (moonrun-js, not an upstream file; copied here by scripts/sync-upstream.ts).
//!
//! Upstream `filesystem/job/**` runs the filesystem syscalls of the async Jobs; in
//! moonrun-js the Jobs run in the TypeScript kernel. `filesystem/mod.rs` declares
//! `mod job;` and re-exports `job::Job` (the `stdio-reexport` rewrite replaces `stdio_kind` with the WASI
//! check below), so that name is the bridge: as a
//! child of `filesystem` this module can reach `HostFs`'s `pub(super)` checks.
//! `Job` here keeps only what `Job::check_policy` looks at, and `check_policy` with its
//! helpers mirrors upstream `filesystem/job/mod.rs` `check_policy`,
//! `check_file_policy` and `check_path_metadata_policy` (moon 940aa18); keep the
//! mapping in step when the pin moves.
//!
//! Two inputs differ in form only. A Resource's `FileGrant` arrives as the kernel's
//! record (stdio, untracked, or the canonical path saved when the file was opened),
//! and a parent directory arrives as that saved path instead of a handle whose path
//! upstream queries from the OS (`directory_path_for_policy`); an unknown path is
//! `None`, which a policy denies for a relative name as upstream's lookup failure does.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::host::HostFs;
use super::{FileGrant, FileOperation};
use crate::abi::Grant;
use crate::async_host::AsyncHostResult;
use crate::policy::FsIntents;

/// `stat::STAT_OPEN_IDENTITY` (file kind | device id | file id).
pub(crate) const STAT_OPEN_IDENTITY: u32 = 0x0001 | 0x0004 | 0x0008;
/// `stat::STAT_FILE_KIND`.
pub(crate) const STAT_FILE_KIND: u32 = 0x0001;

/// `Resource::file_grant` from the kernel's record (`crate::abi::Grant`).
fn file_grant(grant: &Grant) -> FileGrant {
    match grant {
        Grant::Stdio => FileGrant::STDIO,
        Grant::Opened(path) => FileGrant::from_opened_path(path.clone()),
        Grant::Untracked => FileGrant::UNTRACKED,
    }
}

pub(crate) struct Job {
    kind: Kind,
}

enum Kind {
    Open { filename: OsString, access: i32, create_mode: i32, mask: u32 },
    /// `Fstatx` (with its request mask), `FileSize` and `FileTime` (`mask` None).
    FileMetadata { file: Grant, mask: Option<u32> },
    /// `Statx`, `FileKindByPath`; `parent` is `Some(saved path)` for a parent handle.
    StatPath { parent: Option<Option<PathBuf>>, path: OsString, follow_symlink: bool },
    FileTimeByPath { path: OsString, follow_symlink: bool },
    /// `Realpath`, `InotifyAddWatch`.
    Metadata { path: OsString },
    Access { path: OsString, access: i32 },
    Chmod { path: OsString },
    Flock { file: Grant, exclusive: bool },
    Remove { path: OsString },
    Rename { old_path: OsString, new_path: OsString },
    /// `Symlink`, `Mkdir`, `Rmdir`.
    WriteEntry { path: OsString },
    /// `Read`, `Write`, `ReadConsole`, `WriteConsole`, `Fsync`, `Readdir`.
    Unchecked,
}

impl Job {
    /// `Job::open` without a parent; `mask` is the stat request mask.
    pub(crate) fn open(filename: OsString, access: i32, create_mode: i32, mask: u32) -> Self {
        Self { kind: Kind::Open { filename, access, create_mode, mask } }
    }

    /// `Job::fstatx` (`Some(mask)`), `Job::file_size`, `Job::file_time` (`None`).
    pub(crate) fn file_metadata(file: Grant, mask: Option<u32>) -> Self {
        Self { kind: Kind::FileMetadata { file, mask } }
    }

    pub(crate) fn stat_path(parent: Option<Option<PathBuf>>, path: OsString, follow_symlink: bool) -> Self {
        Self { kind: Kind::StatPath { parent, path, follow_symlink } }
    }

    pub(crate) fn file_time_by_path(path: OsString, follow_symlink: bool) -> Self {
        Self { kind: Kind::FileTimeByPath { path, follow_symlink } }
    }

    pub(crate) fn path_metadata(path: OsString) -> Self {
        Self { kind: Kind::Metadata { path } }
    }

    pub(crate) fn access(path: OsString, access: i32) -> Self {
        Self { kind: Kind::Access { path, access } }
    }

    pub(crate) fn chmod(path: OsString) -> Self {
        Self { kind: Kind::Chmod { path } }
    }

    pub(crate) fn flock(file: Grant, exclusive: bool) -> Self {
        Self { kind: Kind::Flock { file, exclusive } }
    }

    pub(crate) fn remove(path: OsString) -> Self {
        Self { kind: Kind::Remove { path } }
    }

    pub(crate) fn rename(old_path: OsString, new_path: OsString) -> Self {
        Self { kind: Kind::Rename { old_path, new_path } }
    }

    pub(crate) fn write_entry(path: OsString) -> Self {
        Self { kind: Kind::WriteEntry { path } }
    }

    pub(crate) fn unchecked() -> Self {
        Self { kind: Kind::Unchecked }
    }

    pub(crate) fn check_policy(&self, filesystem: &HostFs) -> AsyncHostResult<()> {
        match &self.kind {
            Kind::Open { filename, access, create_mode, mask } => {
                filesystem.authorize_open(filename, *access, *create_mode)?;
                if mask & !STAT_OPEN_IDENTITY != 0 {
                    filesystem.authorize_metadata(filename)?;
                }
                Ok(())
            }
            Kind::FileMetadata { file, mask } => check_file_policy(
                filesystem,
                file,
                if *mask == Some(STAT_FILE_KIND) { FileOperation::Kind } else { FileOperation::Metadata },
            ),
            Kind::StatPath { parent, path, follow_symlink } => check_path_metadata_policy(
                filesystem,
                parent.as_ref().map(Option::as_deref),
                path,
                *follow_symlink,
            ),
            Kind::FileTimeByPath { path, follow_symlink } => {
                check_path_metadata_policy(filesystem, None, path, *follow_symlink)
            }
            Kind::Metadata { path } => filesystem.authorize_metadata(path).map_err(Into::into),
            Kind::Access { path, access } => filesystem.authorize_access(path, *access).map_err(Into::into),
            Kind::Chmod { path } => filesystem.authorize_write(path).map_err(Into::into),
            Kind::Flock { file, exclusive } => {
                check_file_policy(filesystem, file, FileOperation::Lock { exclusive: *exclusive })
            }
            Kind::Remove { path } => filesystem.authorize_remove(path).map_err(Into::into),
            Kind::Rename { old_path, new_path } => {
                filesystem.authorize_rename(old_path, new_path).map_err(Into::into)
            }
            Kind::WriteEntry { path } => filesystem.authorize_write_entry(path).map_err(Into::into),
            Kind::Unchecked => Ok(()),
        }
    }
}

fn check_file_policy(filesystem: &HostFs, file: &Grant, operation: FileOperation) -> AsyncHostResult<()> {
    filesystem.authorize_file(&file_grant(file), operation).map_err(Into::into)
}

fn check_path_metadata_policy(
    filesystem: &HostFs,
    parent: Option<Option<&Path>>,
    path: &OsStr,
    follow_symlink: bool,
) -> AsyncHostResult<()> {
    match (parent, follow_symlink) {
        (None, true) => filesystem.authorize_metadata(path).map_err(Into::into),
        (None, false) => filesystem.authorize_entry_metadata(path).map_err(Into::into),
        (Some(base), follow_symlink) => if follow_symlink {
            filesystem.authorize_path_at(base, path, FsIntents::read())
        } else {
            filesystem.authorize_entry_at(base, path, FsIntents::read())
        }
        .map_err(Into::into),
    }
}


/// The authorization each WASI path operation performs through HostFs (moon 940aa18
/// `wasi/mod.rs`): `base` is the directory descriptor's path, `path` the guest's path
/// relative to it, `host_path` the resolved host path. moonrun-js performs the
/// operation itself after this check.
pub(crate) enum WasiCheck<'a> {
    /// `HostFs::open_file_at` with these `FileOpenOptions` (read, any write effect).
    OpenFileAt { base: &'a Path, path: &'a OsStr, read: bool, write: bool },
    /// `HostFs::open_directory_at`.
    OpenDirectoryAt { base: &'a Path, path: &'a OsStr },
    /// `HostFs::read_link`.
    ReadLink { host_path: &'a OsStr },
    /// `HostFs::create_directory`.
    CreateDirectory { host_path: &'a OsStr },
    /// `HostFs::rename`.
    Rename { old_host_path: &'a OsStr, new_host_path: &'a OsStr },
    /// `HostFs::remove_directory_at` / `HostFs::unlink_file_at`.
    RemoveAt { base: &'a Path, path: &'a OsStr },
    /// `HostFs::read_directory`.
    ReadDirectory { host_path: &'a OsStr },
}

/// `relative_path(base, path)` of host.rs for a Unix relative guest path: kept as is,
/// `.` when empty. (An absolute guest path resolves to itself.)
fn relative(path: &OsStr) -> &OsStr {
    if path.is_empty() { OsStr::new(".") } else { path }
}

pub(crate) fn check_wasi(filesystem: &HostFs, check: WasiCheck<'_>) -> Result<(), super::FsError> {
    match check {
        WasiCheck::OpenFileAt { base, path, read, write } => {
            filesystem.authorize_path_at(Some(base), relative(path), FsIntents::new(read, write))
        }
        WasiCheck::OpenDirectoryAt { base, path } => {
            filesystem.authorize_path_at(Some(base), relative(path), FsIntents::read())
        }
        WasiCheck::ReadLink { host_path } => filesystem.authorize_entry_metadata(host_path),
        WasiCheck::CreateDirectory { host_path } => filesystem.authorize_write_entry(host_path),
        WasiCheck::Rename { old_host_path, new_host_path } => {
            filesystem.authorize_rename(old_host_path, new_host_path)
        }
        WasiCheck::RemoveAt { base, path } => {
            filesystem.authorize_entry_at(Some(base), relative(path), FsIntents::write())
        }
        WasiCheck::ReadDirectory { host_path } => filesystem.authorize_read(host_path),
    }
}
