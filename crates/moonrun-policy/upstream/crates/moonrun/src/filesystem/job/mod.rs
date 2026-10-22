//! STUB (moonrun-js, not an upstream file; copied here by scripts/sync-upstream.ts).
//!
//! Upstream `filesystem/job/**` runs the filesystem syscalls of the async Jobs; in
//! moonrun-js the Jobs run in the TypeScript kernel. `filesystem/mod.rs` declares
//! `mod job;` and re-exports `job::Job`, so that name is the bridge: as a child of
//! `filesystem` this module can reach `HostFs`'s private `authorize_*` checks.
//! `Job` here keeps only what `Job::check_policy` looks at, and `check_policy` with its
//! helpers mirrors upstream `filesystem/job/mod.rs:455-505,856-884` (moon 1af328f);
//! keep the mapping in step when the pin moves.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::HostFs;
use crate::async_host::{AsyncHostError, AsyncHostResult};

/// `stat::STAT_OPEN_IDENTITY` (file kind | device id | file id).
pub(crate) const STAT_OPEN_IDENTITY: u32 = 0x0001 | 0x0004 | 0x0008;

/// What a Job's Resource contributes: `None` when the handle is not a file Resource
/// (upstream `file: None`), else its canonical path recorded at open (`Resource::canonical_path`).
pub(crate) type ResourcePath = Option<Option<PathBuf>>;

pub(crate) struct Job {
    kind: Kind,
}

enum Kind {
    Open { filename: OsString, access: i32, create_mode: i32, append: bool, mask: u32 },
    FileMetadata { file: ResourcePath },
    StatPath { parent: Option<Option<PathBuf>>, path: OsString, follow_symlink: bool },
    FileTimeByPath { path: OsString, follow_symlink: bool },
    Metadata { path: OsString },
    Access { path: OsString, access: i32 },
    Chmod { path: OsString },
    Flock { file: ResourcePath, exclusive: bool },
    Remove { path: OsString },
    Rename { old_path: OsString, new_path: OsString },
    WriteEntry { path: OsString },
    Unchecked,
}

impl Job {
    /// `Job::open`; `mask` is the stat request mask.
    pub(crate) fn open(filename: OsString, access: i32, create_mode: i32, append: bool, mask: u32) -> Self {
        Self { kind: Kind::Open { filename, access, create_mode, append, mask } }
    }

    /// `Job::fstatx`, `Job::file_size`, `Job::file_time`.
    pub(crate) fn file_metadata(file: ResourcePath) -> Self {
        Self { kind: Kind::FileMetadata { file } }
    }

    /// `Job::statx`, `Job::file_kind_by_path`; `parent` is the parent Resource's canonical path.
    pub(crate) fn stat_path(parent: Option<Option<PathBuf>>, path: OsString, follow_symlink: bool) -> Self {
        Self { kind: Kind::StatPath { parent, path, follow_symlink } }
    }

    pub(crate) fn file_time_by_path(path: OsString, follow_symlink: bool) -> Self {
        Self { kind: Kind::FileTimeByPath { path, follow_symlink } }
    }

    /// `Job::realpath`, `Job::inotify_add_watch`.
    pub(crate) fn path_metadata(path: OsString) -> Self {
        Self { kind: Kind::Metadata { path } }
    }

    pub(crate) fn access(path: OsString, access: i32) -> Self {
        Self { kind: Kind::Access { path, access } }
    }

    pub(crate) fn chmod(path: OsString) -> Self {
        Self { kind: Kind::Chmod { path } }
    }

    pub(crate) fn flock(file: ResourcePath, exclusive: bool) -> Self {
        Self { kind: Kind::Flock { file, exclusive } }
    }

    pub(crate) fn remove(path: OsString) -> Self {
        Self { kind: Kind::Remove { path } }
    }

    pub(crate) fn rename(old_path: OsString, new_path: OsString) -> Self {
        Self { kind: Kind::Rename { old_path, new_path } }
    }

    /// `Job::symlink`, `Job::mkdir`, `Job::rmdir`.
    pub(crate) fn write_entry(path: OsString) -> Self {
        Self { kind: Kind::WriteEntry { path } }
    }

    /// `Job::read`, `write`, `fsync`, `readdir`: authorized when the file was opened.
    pub(crate) fn unchecked() -> Self {
        Self { kind: Kind::Unchecked }
    }

    pub(crate) fn check_policy(&self, filesystem: &HostFs) -> AsyncHostResult<()> {
        match &self.kind {
            Kind::Open { filename, access, create_mode, append, mask } => {
                filesystem.authorize_open(filename, *access, *create_mode, *append)?;
                if mask & !STAT_OPEN_IDENTITY != 0 {
                    filesystem.authorize_metadata(filename)?;
                }
                Ok(())
            }
            Kind::FileMetadata { file } => check_file_metadata_policy(filesystem, file),
            Kind::StatPath { parent, path, follow_symlink } => check_path_metadata_policy(
                filesystem,
                parent.as_ref().map(Option::as_deref),
                path,
                *follow_symlink,
            ),
            Kind::FileTimeByPath { path, follow_symlink } => {
                check_path_metadata_policy(filesystem, None, path, *follow_symlink)
            }
            Kind::Metadata { path } => filesystem.authorize_metadata(path),
            Kind::Access { path, access } => filesystem.authorize_access(path, *access),
            Kind::Chmod { path } => filesystem.authorize_write(path),
            Kind::Flock { file, exclusive } => check_file_lock_policy(filesystem, file, *exclusive),
            Kind::Remove { path } => filesystem.authorize_remove(path),
            Kind::Rename { old_path, new_path } => filesystem.authorize_rename(old_path, new_path),
            Kind::WriteEntry { path } => filesystem.authorize_write_entry(path),
            Kind::Unchecked => Ok(()),
        }
    }
}

fn check_file_metadata_policy(filesystem: &HostFs, file: &ResourcePath) -> AsyncHostResult<()> {
    let file = file.as_ref().ok_or(AsyncHostError::Badf)?;
    filesystem.authorize_resource_metadata(file.as_deref())
}

fn check_path_metadata_policy(
    filesystem: &HostFs,
    parent: Option<Option<&Path>>,
    path: &OsStr,
    follow_symlink: bool,
) -> AsyncHostResult<()> {
    match (parent, follow_symlink) {
        (None, true) => filesystem.authorize_metadata(path),
        (None, false) => filesystem.authorize_entry_metadata(path),
        (Some(parent), true) => filesystem.authorize_metadata_at(parent, path),
        (Some(parent), false) => filesystem.authorize_entry_metadata_at(parent, path),
    }
}

fn check_file_lock_policy(filesystem: &HostFs, file: &ResourcePath, exclusive: bool) -> AsyncHostResult<()> {
    let file = file.as_ref().ok_or(AsyncHostError::Badf)?;
    filesystem.authorize_resource_lock(file.as_deref(), exclusive)
}
