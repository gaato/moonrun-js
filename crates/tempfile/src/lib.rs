//! `tempfile::tempfile()` for policy inheritance: the payload stays in memory; the host
//! materializes the descriptor for a child process itself.

pub fn tempfile() -> std::io::Result<os::MemFile> {
    Ok(os::MemFile::default())
}
