// moonrun-js always behaves as Linux (see .cargo/config.toml).
fn main() {
    println!("cargo:rustc-cfg=unix");
}
