//! moonrun-policy: upstream `policy/**`, `runtime/environment*.rs`,
//! `runtime/working_directory.rs`, `filesystem/mod.rs` (Host Filesystem) and
//! `sqlite/policy.rs`, verbatim, behind the C ABI in `abi.rs`. One instance serves one Run.
#![allow(dead_code, unused_imports)]

pub(crate) use ::os;

// Before the upstream modules: textual macro scope shadows std's `eprintln!`, so the
// denial lines (`Sandbox policy blocked ...`) reach the run's stderr synchronously.
macro_rules! eprintln {
    ($($arg:tt)*) => { ::os::os_eprintln!($($arg)*) };
}

/// What these files use from async_host/mod.rs (OS-bound): the error type and its
/// conversions (moon 940aa18 `async_host/mod.rs:158-217`, the Linux errno values).
mod async_host {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum AsyncHostError {
        Fault,
        Inval,
        Io,
        Badf,
        PermissionDenied,
        Native(i32),
    }
    pub(crate) type AsyncHostResult<T> = Result<T, AsyncHostError>;

    mod native_errno {
        pub(crate) const BADF: i32 = 9;
        pub(crate) const ACCESS: i32 = 13;
        pub(crate) const FAULT: i32 = 14;
        pub(crate) const INVAL: i32 = 22;
        pub(crate) const IO: i32 = 5;
    }

    impl AsyncHostError {
        pub(crate) fn errno(self) -> i32 {
            match self {
                Self::Fault => native_errno::FAULT,
                Self::Inval => native_errno::INVAL,
                Self::Io => native_errno::IO,
                Self::Badf => native_errno::BADF,
                Self::PermissionDenied => native_errno::ACCESS,
                Self::Native(errno) => errno,
            }
        }
    }

    impl From<std::io::Error> for AsyncHostError {
        fn from(error: std::io::Error) -> Self {
            Self::Native(error.raw_os_error().unwrap_or(native_errno::INVAL))
        }
    }

    impl From<crate::filesystem::FsError> for AsyncHostError {
        fn from(error: crate::filesystem::FsError) -> Self {
            match error {
                crate::filesystem::FsError::Denied => Self::PermissionDenied,
                crate::filesystem::FsError::Io(error) => error.into(),
            }
        }
    }

    impl From<AsyncHostError> for crate::filesystem::FsError {
        fn from(error: AsyncHostError) -> Self {
            match error {
                AsyncHostError::PermissionDenied => Self::Denied,
                _ => Self::Io(std::io::Error::from_raw_os_error(error.errno())),
            }
        }
    }
}

/// serde's `OsString` representation on Unix (`{"Unix": [bytes]}`), which serde only
/// provides for `cfg(unix)`/`cfg(windows)` targets. The `serde-os-string-*` rewrites
/// attach it to the policy transfer's path fields so moonrun-js reads and writes the
/// same transfer bytes as moonrun.
mod os_serde {
    use std::ffi::OsString;
    use std::fmt;

    use serde::de::{EnumAccess, Error, VariantAccess, Visitor};
    use serde::{Deserializer, Serializer};

    pub(crate) fn serialize<S: Serializer>(value: &OsString, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_newtype_variant("OsString", 0, "Unix", value.as_encoded_bytes())
    }

    const VARIANTS: &[&str] = &["Unix", "Windows"];

    enum Kind {
        Unix,
        Windows,
    }

    impl<'de> serde::Deserialize<'de> for Kind {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct KindVisitor;
            impl Visitor<'_> for KindVisitor {
                type Value = Kind;
                fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                    formatter.write_str("`Unix` or `Windows`")
                }
                fn visit_u64<E: Error>(self, value: u64) -> Result<Kind, E> {
                    match value {
                        0 => Ok(Kind::Unix),
                        1 => Ok(Kind::Windows),
                        _ => Err(Error::invalid_value(serde::de::Unexpected::Unsigned(value), &self)),
                    }
                }
                fn visit_str<E: Error>(self, value: &str) -> Result<Kind, E> {
                    match value {
                        "Unix" => Ok(Kind::Unix),
                        "Windows" => Ok(Kind::Windows),
                        _ => Err(Error::unknown_variant(value, VARIANTS)),
                    }
                }
                fn visit_bytes<E: Error>(self, value: &[u8]) -> Result<Kind, E> {
                    match value {
                        b"Unix" => Ok(Kind::Unix),
                        b"Windows" => Ok(Kind::Windows),
                        _ => Err(Error::unknown_variant(&String::from_utf8_lossy(value), VARIANTS)),
                    }
                }
            }
            deserializer.deserialize_identifier(KindVisitor)
        }
    }

    struct OsStringVisitor;

    impl<'de> Visitor<'de> for OsStringVisitor {
        type Value = OsString;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("os string")
        }

        fn visit_enum<A: EnumAccess<'de>>(self, data: A) -> Result<OsString, A::Error> {
            match data.variant()? {
                (Kind::Unix, variant) => variant
                    .newtype_variant::<Vec<u8>>()
                    // SAFETY: OsString on this target is plain bytes (the Unix representation).
                    .map(|bytes| unsafe { OsString::from_encoded_bytes_unchecked(bytes) }),
                (Kind::Windows, _) => Err(Error::custom("cannot deserialize Windows OS string on Unix")),
            }
        }
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<OsString, D::Error> {
        deserializer.deserialize_enum("OsString", VARIANTS, OsStringVisitor)
    }
}

// runtime/mod.rs is OS-bound; only these files of `runtime` are reused. They sit at the
// crate root so that environment_provisioning.rs's `super::Env` resolves.
#[path = "../upstream/crates/moonrun/src/runtime/environment.rs"]
mod environment;
#[path = "../upstream/crates/moonrun/src/runtime/environment_provisioning.rs"]
mod environment_provisioning;
#[path = "../upstream/crates/moonrun/src/runtime/working_directory.rs"]
mod working_directory;
pub(crate) use environment::Env;

mod runtime {
    pub(crate) use crate::environment::Env;
    pub(crate) use crate::environment_provisioning::{EnvConfig, EnvProvisioning};
    pub(crate) use crate::working_directory::WorkingDirectory;

    /// runtime/mod.rs `null_handle`: slotmap's `KeyData::null().as_ffi()`.
    pub(crate) fn null_handle() -> u64 {
        0x1_ffff_ffff
    }
}

/// Stand-in for async_sys/fs/stub.rs's tmp-path helpers (that file is libc-bound).
mod async_sys {
    pub(crate) mod fs {
        pub(crate) mod stub {
            use std::ffi::OsString;

            use crate::async_host::AsyncHostResult;

            pub(crate) fn get_tmp_path() -> AsyncHostResult<OsString> {
                get_tmp_path_from_env(crate::os::env::var_os("TMPDIR"))
            }

            /// Upstream `tmp_path_from_env` on Unix: `$TMPDIR` with a trailing `/`, else `/tmp/`.
            pub(crate) fn get_tmp_path_from_env(tmpdir: Option<OsString>) -> AsyncHostResult<OsString> {
                let mut path = tmpdir.filter(|v| !v.is_empty()).unwrap_or_else(|| "/tmp".into());
                if !path.as_encoded_bytes().ends_with(b"/") {
                    path.push("/");
                }
                Ok(path)
            }
        }
    }
}

#[path = "../upstream/crates/moonrun/src/policy/mod.rs"]
mod policy;

#[path = "../upstream/crates/moonrun/src/filesystem/mod.rs"]
mod filesystem;

/// The `__moonbit_fs_unstable` presentation over HostFs. Its items are `pub(super)`,
/// so the exports that drive it (`bridge.rs`) live inside this module.
mod unstable_api {
    #[path = "../../upstream/crates/moonrun/src/unstable_api/filesystem.rs"]
    mod filesystem;
    pub(crate) mod bridge;
}

// SQLite admission and the SQL authorizer. At the crate root (not inside `mod sqlite`) so
// its `pub(super)` items are reachable from `abi.rs`; `libsqlite3_sys` is crates/libsqlite3-sys.
#[path = "../upstream/crates/moonrun/src/sqlite/policy.rs"]
mod sqlite_policy;

mod abi;
