//! Cuts `struct Commandline` (with its attributes and doc comments) out of the verbatim
//! upstream main.rs; the rest of main.rs drives the engine and the OS.
use std::path::PathBuf;

fn main() {
    let source = "upstream/crates/moonrun/src/main.rs";
    println!("cargo:rerun-if-changed={source}");
    let text = std::fs::read_to_string(source).expect("upstream main.rs (run scripts/sync-upstream.ts)");
    let start = text
        .find("#[derive(Debug, clap::Parser)]")
        .expect("`#[derive(Debug, clap::Parser)]` before `struct Commandline`");
    let body = &text[start..];
    assert!(body.contains("struct Commandline {"), "`struct Commandline` follows the derive");
    let end = body.find("\n}\n").expect("end of `struct Commandline`") + 3;
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("commandline.rs");
    std::fs::write(out, &body[..end]).unwrap();
}
