//! moonrun-policy: upstream `policy/**`, `runtime/environment*.rs`,
//! `runtime/working_directory.rs` and `filesystem/mod.rs` (Host Filesystem), verbatim,
//! behind the C ABI in `abi.rs`. One instance serves one Run.
#![allow(dead_code, unused_imports)]

pub(crate) use ::os;

// Before the upstream modules: textual macro scope shadows std's `eprintln!`, so the
// denial lines (`Sandbox policy blocked ...`) reach the run's stderr synchronously.
macro_rules! eprintln {
    ($($arg:tt)*) => { ::os::os_eprintln!($($arg)*) };
}

/// The two items these files use from async_host/mod.rs (OS-bound).
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
    pub(crate) use crate::environment_provisioning::EnvProvisioning;
    pub(crate) use crate::working_directory::WorkingDirectory;
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

mod abi;
