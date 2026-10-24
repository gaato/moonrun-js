//! moonutil items moonrun uses: `demangle` and `front_matter` are upstream files;
//! the rest are stand-ins for what those files or moonrun name.
#![allow(dead_code)]

pub(crate) use ::os;

#[path = "../upstream/crates/moonutil/src/demangle.rs"]
pub mod demangle;

#[cfg(feature = "front_matter")]
#[path = "../upstream/crates/moonutil/src/front_matter.rs"]
pub mod front_matter;

#[cfg(feature = "front_matter")]
#[path = "../upstream/crates/moonutil/src/moon_pkg/mod.rs"]
pub mod moon_pkg;

#[cfg(feature = "front_matter")]
mod target;

/// Only `DOT_MBT_DOT_MD` (front_matter.rs's `.mbt.md` branch).
#[cfg(feature = "front_matter")]
pub mod constants {
    pub const DOT_MBT_DOT_MD: &str = ".mbt.md";
}

/// Named by front_matter.rs's `.mbt.md` header type only (not used by moonrun).
#[cfg(feature = "front_matter")]
pub mod dependency {
    #[derive(Debug, serde::Deserialize)]
    pub struct SourceDependencyInfo {}
}

#[cfg(feature = "front_matter")]
pub mod package {
    #[derive(Debug, serde::Deserialize)]
    pub struct PkgJSONImport {}

    /// The upstream import's serde shape. The parser validates syntax; the
    /// front-matter reader rejects conditional imports before deserializing.
    #[derive(Debug, serde::Deserialize)]
    #[serde(untagged)]
    pub enum Import {
        Simple(String),
        Alias {
            path: String,
            alias: Option<String>,
            #[serde(default)]
            sub_package: bool,
            #[serde(default, alias = "import-all")]
            import_all: bool,
            #[serde(default)]
            targets: Option<indexmap::IndexSet<crate::target::TargetBackend>>,
        },
    }

    impl Import {
        pub fn get_path(&self) -> &str {
            match self {
                Self::Simple(path) | Self::Alias { path, .. } => path,
            }
        }
    }
}

/// Stand-in for moonutil::policy_transport (which passes an fd to children): the
/// payload is kept in memory and read back by the component's ABI.
#[cfg(feature = "policy_transport")]
pub mod policy_transport {
    use std::io::Read;

    #[derive(Debug)]
    pub struct PolicyTransfer {
        file: os::MemFile,
    }

    impl PolicyTransfer {
        pub fn from_file(file: os::MemFile) -> std::io::Result<Self> {
            Ok(Self { file })
        }

        pub fn read(mut self) -> std::io::Result<Vec<u8>> {
            let mut contents = Vec::new();
            self.file.read_to_end(&mut contents)?;
            Ok(contents)
        }
    }
}
