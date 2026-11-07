//! Cuts `struct MoonrunCli` (with its attributes and doc comments) out of the verbatim
//! upstream cli_support.rs; the rest of that file is its version string and tests.
use std::path::PathBuf;

fn main() {
    let source = "upstream/crates/moonrun/src/cli_support.rs";
    println!("cargo:rerun-if-changed={source}");
    let text = std::fs::read_to_string(source).expect("upstream cli_support.rs (run scripts/sync-upstream.ts)");
    let start = text
        .find("#[derive(Debug, clap::Parser)]")
        .expect("`#[derive(Debug, clap::Parser)]` before `struct MoonrunCli`");
    let body = &text[start..];
    assert!(body.contains("pub struct MoonrunCli {"), "`struct MoonrunCli` follows the derive");
    let end = body.find("\n}\n").expect("end of `struct MoonrunCli`") + 3;
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("commandline.rs");
    std::fs::write(out, &body[..end]).unwrap();
}
