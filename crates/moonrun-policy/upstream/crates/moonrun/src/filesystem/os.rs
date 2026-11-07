//! STUB (moonrun-js, not an upstream file; copied here by scripts/sync-upstream.ts).
//!
//! Upstream `filesystem/os{,/**}.rs` performs handle-relative OS calls (`openat`,
//! `unlinkat`, renameat2, the path of an open directory) for `HostFs`'s
//! directory-relative operations. moonrun-js's hosts run every filesystem effect in
//! TypeScript, and this component only uses `HostFs` for authorization and the
//! `__moonbit_fs_unstable` path operations, which go through `crate::os::fs`. These
//! items keep upstream `filesystem/host.rs` compiling; each mechanism fails as
//! unsupported if it were ever reached. Keep the signatures in step with moon's
//! `filesystem/os.rs` and `filesystem/os/{openat,directory,unlinkat}.rs`.

use std::{io, path::Path};

pub(super) type RawFile = i32;

pub(super) fn raw_file(_file: &crate::os::fs::File) -> RawFile {
    -1
}

fn unsupported<T>() -> io::Result<T> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

pub(super) trait BlockingIo {
    fn run<T>(&self, operation: impl FnOnce() -> io::Result<T>) -> io::Result<T>;
}

pub(super) struct DirectIo;

impl BlockingIo for DirectIo {
    fn run<T>(&self, operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        operation()
    }
}

#[derive(Clone, Copy)]
pub(super) enum CrossDevice {
    Reject,
    AllowCopy,
}

pub(super) struct RenameOptions {
    pub(super) replace: bool,
    pub(super) cross_device: CrossDevice,
}

pub(super) fn rename(_old_path: &Path, _new_path: &Path, _options: RenameOptions) -> io::Result<()> {
    unsupported()
}

pub(super) mod directory {
    use std::{io, path::PathBuf};

    use super::RawFile;

    pub(in crate::filesystem) fn path(_handle: RawFile) -> io::Result<PathBuf> {
        super::unsupported()
    }
}

pub(super) mod openat {
    use std::{ffi::OsStr, io};

    use super::{BlockingIo, RawFile};
    use crate::os::fs::File;

    pub(in crate::filesystem) enum Access {
        Read,
        Write,
        ReadWrite,
        ListDirectory,
        TraverseDirectory,
        Attributes,
        Delete,
    }

    pub(in crate::filesystem) enum TypeConstraint {
        Any,
        Directory,
        NonDirectory,
    }

    pub(in crate::filesystem) enum CreateMode {
        Open,
        Truncate,
        Create,
        CreateOrTruncate,
        Exclusive,
    }

    pub(in crate::filesystem) enum Sync {
        None,
        Data,
        All,
    }

    pub(in crate::filesystem) struct OpenOptions {
        pub access: Access,
        pub type_constraint: TypeConstraint,
        pub follow_symlink: bool,
        pub is_async: bool,
        pub create: CreateMode,
        pub append: bool,
        pub sync: Sync,
        pub permission: u32,
    }

    pub(in crate::filesystem) fn open(
        _parent: Option<RawFile>,
        _path: &OsStr,
        _options: &OpenOptions,
        _blocking: &impl BlockingIo,
    ) -> io::Result<File> {
        super::unsupported()
    }
}

pub(super) mod unlinkat {
    use std::{ffi::OsStr, io};

    use super::{BlockingIo, RawFile};

    pub(in crate::filesystem) fn remove_at(
        _parent: Option<RawFile>,
        _path: &OsStr,
        _blocking: &impl BlockingIo,
    ) -> io::Result<()> {
        super::unsupported()
    }

    pub(in crate::filesystem) fn unlink_file_at(
        _parent: Option<RawFile>,
        _path: &OsStr,
        _blocking: &impl BlockingIo,
    ) -> io::Result<()> {
        super::unsupported()
    }

    pub(in crate::filesystem) fn remove_directory_at(
        _parent: Option<RawFile>,
        _path: &OsStr,
        _blocking: &impl BlockingIo,
    ) -> io::Result<()> {
        super::unsupported()
    }
}
