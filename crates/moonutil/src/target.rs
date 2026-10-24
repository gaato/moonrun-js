//! The backend vocabulary used by the upstream package parser. Keeping the
//! five backends here avoids importing moonutil's build-planning dependencies.

#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum TargetBackend {
    Wasm,
    WasmGC,
    Js,
    Native,
    LLVM,
}

impl TargetBackend {
    pub fn all() -> &'static [Self] {
        &[Self::Wasm, Self::WasmGC, Self::Js, Self::Native, Self::LLVM]
    }

    pub fn to_flag(self) -> &'static str {
        match self {
            Self::Wasm => "wasm",
            Self::WasmGC => "wasm-gc",
            Self::Js => "js",
            Self::Native => "native",
            Self::LLVM => "llvm",
        }
    }

    pub fn str_to_backend(value: &str) -> anyhow::Result<Self> {
        match value {
            "wasm" => Ok(Self::Wasm),
            "wasm-gc" => Ok(Self::WasmGC),
            "js" => Ok(Self::Js),
            "native" => Ok(Self::Native),
            "llvm" => Ok(Self::LLVM),
            _ => anyhow::bail!(
                "invalid backend: {}, only support wasm, wasm-gc, js, native, llvm",
                value
            ),
        }
    }
}
