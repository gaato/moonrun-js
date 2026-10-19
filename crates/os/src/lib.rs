//! The OS-equivalent layer for upstream moonrun files compiled to wasm32-unknown-unknown.
//!
//! On this target std's OS functions compile but fail at run time (`Unsupported`,
//! `false`, or a panic). `scripts/sync-upstream.ts` therefore rewrites the upstream
//! paths `std::fs::X`, `std::env::X`, `std::os::{unix,fd}::X` and
//! `Path::new(p).{is_file,is_dir,exists}()` to this crate (re-exported by each
//! component as `crate::os`). Everything here goes through the `host` import module,
//! which the TypeScript side implements over its ports.
//!
//! Host imports return `0` on success or a Linux errno. A variable-size success value
//! is written by the host into a buffer it obtains from the export `os_result_alloc`.

use std::cell::RefCell;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

#[link(wasm_import_module = "host")]
unsafe extern "C" {
    fn read_file(path: *const u8, path_len: usize) -> i32;
    fn write_file(path: *const u8, path_len: usize, data: *const u8, data_len: usize) -> i32;
    /// Result: NUL-terminated entry names (UTF-8 only, no `.`/`..`), in directory order.
    fn read_dir(path: *const u8, path_len: usize) -> i32;
    /// Result: one byte, 1 file, 2 directory, 3 symlink, 0 other. `follow` != 0 = stat.
    fn stat(path: *const u8, path_len: usize, follow: i32) -> i32;
    fn mkdir(path: *const u8, path_len: usize) -> i32;
    fn remove_file(path: *const u8, path_len: usize) -> i32;
    /// Rust `remove_dir_all`: a symlink is unlinked, anything else must be a directory.
    fn remove_dir_all(path: *const u8, path_len: usize) -> i32;
    fn realpath(path: *const u8, path_len: usize) -> i32;
    fn getcwd() -> i32;
    /// Result: NUL-terminated `name=value` entries.
    fn environ() -> i32;
    /// 0 with the value as result, or ENOENT (2) when unset.
    fn getenv(name: *const u8, name_len: usize) -> i32;
    /// Result: glibc `strerror` text of a Linux errno (always 0).
    fn strerror(errno: i32) -> i32;
    fn write_stderr(data: *const u8, data_len: usize);
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Where the host writes a variable-size import result.
#[unsafe(no_mangle)]
pub extern "C" fn os_result_alloc(len: usize) -> *mut u8 {
    RESULT.with(|result| {
        let mut result = result.borrow_mut();
        *result = vec![0; len];
        result.as_mut_ptr()
    })
}

fn take_result() -> Vec<u8> {
    RESULT.with(|result| std::mem::take(&mut *result.borrow_mut()))
}

/// `{strerror} (os error {N})`, the Display of std's OS errors. (`raw_os_error()` is None:
/// on this target std would render every OS error as "operation successful".)
#[derive(Debug)]
struct LinuxError {
    code: i32,
    text: String,
}

impl std::fmt::Display for LinuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (os error {})", self.text, self.code)
    }
}

impl std::error::Error for LinuxError {}

/// An `io::Error` for a Linux errno, with glibc's text and std's `ErrorKind` mapping.
pub fn linux_error(code: i32) -> io::Error {
    use io::ErrorKind as K;
    let kind = match code {
        1 | 13 => K::PermissionDenied,
        2 => K::NotFound,
        4 => K::Interrupted,
        11 => K::WouldBlock,
        12 => K::OutOfMemory,
        17 => K::AlreadyExists,
        18 => K::CrossesDevices,
        20 => K::NotADirectory,
        21 => K::IsADirectory,
        22 => K::InvalidInput,
        26 => K::ExecutableFileBusy,
        27 => K::FileTooLarge,
        28 => K::StorageFull,
        29 => K::NotSeekable,
        30 => K::ReadOnlyFilesystem,
        31 => K::TooManyLinks,
        32 => K::BrokenPipe,
        39 => K::DirectoryNotEmpty,
        110 => K::TimedOut,
        _ => K::Other,
    };
    let text = if unsafe { strerror(code) } == 0 {
        String::from_utf8_lossy(&take_result()).into_owned()
    } else {
        format!("Unknown error {code}")
    };
    io::Error::new(kind, LinuxError { code, text })
}

fn call(rc: i32) -> io::Result<Vec<u8>> {
    if rc == 0 { Ok(take_result()) } else { Err(linux_error(rc)) }
}

/// The bytes std would pass to the OS. Like std: a NUL is rejected before any call,
/// and the empty path is ENOENT (the host would resolve `""` to its cwd).
fn path_arg(path: &Path) -> io::Result<&[u8]> {
    let bytes = path.as_os_str().as_encoded_bytes();
    if bytes.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file name contained an unexpected NUL byte",
        ));
    }
    if bytes.is_empty() {
        return Err(linux_error(2));
    }
    Ok(bytes)
}

fn path_call(path: &Path, f: unsafe extern "C" fn(*const u8, usize) -> i32) -> io::Result<Vec<u8>> {
    let bytes = path_arg(path)?;
    call(unsafe { f(bytes.as_ptr(), bytes.len()) })
}

fn os_string(bytes: Vec<u8>) -> OsString {
    // SAFETY: OsString on this target is plain bytes (the Unix representation).
    unsafe { OsString::from_encoded_bytes_unchecked(bytes) }
}

pub mod fs {
    use super::*;

    /// File types as far as upstream asks (`is_file` / `is_dir` / `is_symlink`).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct FileType(u8);

    impl FileType {
        pub fn is_file(&self) -> bool {
            self.0 == 1
        }
        pub fn is_dir(&self) -> bool {
            self.0 == 2
        }
        pub fn is_symlink(&self) -> bool {
            self.0 == 3
        }
    }

    #[derive(Clone, Debug)]
    pub struct Metadata(FileType);

    impl Metadata {
        pub fn file_type(&self) -> FileType {
            self.0
        }
        pub fn is_file(&self) -> bool {
            self.0.is_file()
        }
        pub fn is_dir(&self) -> bool {
            self.0.is_dir()
        }
        pub fn is_symlink(&self) -> bool {
            self.0.is_symlink()
        }
    }

    pub struct DirEntry {
        path: PathBuf,
    }

    impl DirEntry {
        pub fn path(&self) -> PathBuf {
            self.path.clone()
        }
        pub fn file_name(&self) -> OsString {
            self.path.file_name().map(OsStr::to_owned).unwrap_or_default()
        }
    }

    pub fn read<P: AsRef<Path>>(path: P) -> io::Result<Vec<u8>> {
        path_call(path.as_ref(), read_file)
    }

    pub fn read_to_string<P: AsRef<Path>>(path: P) -> io::Result<String> {
        String::from_utf8(read(path)?).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8")
        })
    }

    pub fn write<P: AsRef<Path>, C: AsRef<[u8]>>(path: P, contents: C) -> io::Result<()> {
        let bytes = path_arg(path.as_ref())?;
        let data = contents.as_ref();
        call(unsafe { write_file(bytes.as_ptr(), bytes.len(), data.as_ptr(), data.len()) })
            .map(drop)
    }

    fn stat_kind(path: &Path, follow: bool) -> io::Result<Metadata> {
        let bytes = path_arg(path)?;
        let kind = call(unsafe { stat(bytes.as_ptr(), bytes.len(), i32::from(follow)) })?;
        Ok(Metadata(FileType(kind.first().copied().unwrap_or(0))))
    }

    pub fn metadata<P: AsRef<Path>>(path: P) -> io::Result<Metadata> {
        stat_kind(path.as_ref(), true)
    }

    pub fn symlink_metadata<P: AsRef<Path>>(path: P) -> io::Result<Metadata> {
        stat_kind(path.as_ref(), false)
    }

    pub fn read_dir<P: AsRef<Path>>(path: P) -> io::Result<std::vec::IntoIter<io::Result<DirEntry>>> {
        let base = path.as_ref();
        let names = path_call(base, super::read_dir)?;
        Ok(names
            .split(|&byte| byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| Ok(DirEntry { path: base.join(os_string(name.to_vec())) }))
            .collect::<Vec<_>>()
            .into_iter())
    }

    pub fn create_dir<P: AsRef<Path>>(path: P) -> io::Result<()> {
        path_call(path.as_ref(), mkdir).map(drop)
    }

    /// std's `DirBuilder::create_dir_all` algorithm over `create_dir`.
    pub fn create_dir_all<P: AsRef<Path>>(path: P) -> io::Result<()> {
        let path = path.as_ref();
        if path == Path::new("") {
            return Ok(());
        }
        match create_dir(path) {
            Ok(()) => return Ok(()),
            Err(ref e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) if super::path::is_dir(path) => return Ok(()),
            Err(e) => return Err(e),
        }
        match path.parent() {
            Some(parent) => create_dir_all(parent)?,
            None => {
                return Err(io::Error::new(io::ErrorKind::Other, "failed to create whole tree"));
            }
        }
        match create_dir(path) {
            Ok(()) => Ok(()),
            Err(_) if super::path::is_dir(path) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn remove_file<P: AsRef<Path>>(path: P) -> io::Result<()> {
        path_call(path.as_ref(), super::remove_file).map(drop)
    }

    pub fn remove_dir_all<P: AsRef<Path>>(path: P) -> io::Result<()> {
        path_call(path.as_ref(), super::remove_dir_all).map(drop)
    }

    pub fn canonicalize<P: AsRef<Path>>(path: P) -> io::Result<PathBuf> {
        path_call(path.as_ref(), realpath).map(|bytes| PathBuf::from(os_string(bytes)))
    }
}

pub mod env {
    use super::*;

    pub fn current_dir() -> io::Result<PathBuf> {
        call(unsafe { getcwd() }).map(|bytes| PathBuf::from(os_string(bytes)))
    }

    pub fn vars_os() -> std::vec::IntoIter<(OsString, OsString)> {
        let bytes = call(unsafe { environ() }).unwrap_or_default();
        bytes
            .split(|&byte| byte == 0)
            .filter(|entry| !entry.is_empty())
            .filter_map(|entry| {
                // Like std on Unix: split at the first `=` after the first byte.
                let at = entry.iter().skip(1).position(|&b| b == b'=')? + 1;
                Some((os_string(entry[..at].to_vec()), os_string(entry[at + 1..].to_vec())))
            })
            .collect::<Vec<_>>()
            .into_iter()
    }

    pub fn var_os<K: AsRef<OsStr>>(key: K) -> Option<OsString> {
        let key = key.as_ref().as_encoded_bytes();
        if key.is_empty() || key.contains(&b'=') || key.contains(&0) {
            return None;
        }
        call(unsafe { getenv(key.as_ptr(), key.len()) }).ok().map(os_string)
    }
}

/// `Path::is_file` / `is_dir` / `exists` (std's versions stat through the unsupported layer).
pub mod path {
    use std::path::Path;

    pub fn is_file(path: &Path) -> bool {
        super::fs::metadata(path).is_ok_and(|m| m.is_file())
    }

    pub fn is_dir(path: &Path) -> bool {
        super::fs::metadata(path).is_ok_and(|m| m.is_dir())
    }

    pub fn exists(path: &Path) -> bool {
        super::fs::metadata(path).is_ok()
    }
}

/// `std::os::unix` extension traits. `OsStr` on this target is byte-backed (the same
/// representation as on Unix), so these are exact.
pub mod unix {
    pub mod ffi {
        use std::ffi::{OsStr, OsString};

        pub trait OsStrExt {
            fn as_bytes(&self) -> &[u8];
            fn from_bytes(bytes: &[u8]) -> &Self;
        }

        impl OsStrExt for OsStr {
            fn as_bytes(&self) -> &[u8] {
                self.as_encoded_bytes()
            }
            fn from_bytes(bytes: &[u8]) -> &Self {
                // SAFETY: byte-backed OsStr accepts any bytes on this target.
                unsafe { OsStr::from_encoded_bytes_unchecked(bytes) }
            }
        }

        pub trait OsStringExt {
            fn from_vec(vec: Vec<u8>) -> Self;
            fn into_vec(self) -> Vec<u8>;
        }

        impl OsStringExt for OsString {
            fn from_vec(vec: Vec<u8>) -> Self {
                super::super::os_string(vec)
            }
            fn into_vec(self) -> Vec<u8> {
                self.into_encoded_bytes()
            }
        }
    }
}

/// `std::os::fd`: host descriptors are plain integers.
pub mod fd {
    pub type RawFd = i32;

    pub trait AsRawFd {
        fn as_raw_fd(&self) -> RawFd;
    }
}

/// An anonymous in-memory file (what the `tempfile` stand-in returns).
#[derive(Debug, Default)]
pub struct MemFile {
    data: Vec<u8>,
    pos: usize,
}

impl io::Write for MemFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let end = self.pos + bytes.len();
        if self.data.len() < end {
            self.data.resize(end, 0);
        }
        self.data[self.pos..end].copy_from_slice(bytes);
        self.pos = end;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl io::Read for MemFile {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = out.len().min(self.data.len().saturating_sub(self.pos));
        out[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl io::Seek for MemFile {
    fn seek(&mut self, to: io::SeekFrom) -> io::Result<u64> {
        let base = match to {
            io::SeekFrom::Start(n) => i128::from(n),
            io::SeekFrom::End(n) => self.data.len() as i128 + i128::from(n),
            io::SeekFrom::Current(n) => self.pos as i128 + i128::from(n),
        };
        self.pos = usize::try_from(base).map_err(|_| linux_error(22))?;
        Ok(self.pos as u64)
    }
}

/// Synchronous write to the run's stderr (moonrun's `eprintln!` interleaves with guest output).
pub fn write_stderr_str(text: &str) {
    unsafe { write_stderr(text.as_ptr(), text.len()) }
}

/// What a component's `eprintln!` expands to (it shadows std's by textual macro scope).
#[macro_export]
macro_rules! os_eprintln {
    ($($arg:tt)*) => {{
        let mut line = ::std::format!($($arg)*);
        line.push('\n');
        $crate::write_stderr_str(&line);
    }};
}
