# moonrun の Rust ソースの流用（2026-10-19 決定）

方針は `docs/plan.md` の「流用の原則」。調査はスクラッチで本家ファイルを wasm32-unknown-unknown にビルドして本家と照合した。

## 決定

| 対象（moon 748b63c） | 判定 | 根拠 | 置き換える TS |
|---|---|---|---|
| `policy/**`、`runtime/environment*.rs`、moonutil `front_matter.rs` | 流用する | 本家と 164/164 一致（TS は `.mbtx` の 7 件で不一致）。上流の変更が多い | `src/domains/policy/*`、`src/hosts/node/policy-loader.ts` の大半 |
| `filesystem/mod.rs`、`runtime/working_directory.rs`（Host Filesystem） | 流用する（下の 3 点を直してから） | 上流の変更が多い（2026-06 以降 26 回）。ポリシー判定と一体 | `src/abi/legacy/fs-unstable.ts`・`fs-runtime.ts` の OS 以外の部分、ポリシーのパス解決 |
| moonutil `demangle.rs`、`source_map.rs`、`wasm_diagnostic.rs`、`memory_sanitizer.rs` | 流用する | 完全にそのままビルドできる。TS 版と差ゼロ | `src/diagnostics/*`、`src/abi/legacy/sanitizer.ts` の大半 |
| `main.rs` の clap 定義（`struct Commandline`） | 流用する | エラーとヘルプが本家と一致。プログラム名と版は実行時に注入（D5） | `src/hosts/node/args.ts` |
| `filesystem/job/stat.rs`（stat 結果の配置） | TS のまま | stat ごとに呼ばれる 65 行で、上流の変更も少ない。流用版 wasm との一致を CI のテストで確かめる | — |
| `sqlite/policy.rs` | 流用する（P5、ポリシー crate に追加） | 純粋なロジック | — |
| `wasi/mod.rs`、`async_api/*` | 流用しない | ゲストのメモリ全体を `&mut [u8]` で受け取る作りで、別インスタンスからは呼び出しごとの全コピーが要る | — |
| `async_host/**`、`async_sys/**`、`process/**`、`network/**`、`sqlite/*`（libsqlite3）、`runtime/{mod,stdio,executable}.rs`、`engine.rs`、`v8/**`、`wasmtime/**` | 流用しない | OS（libc・スレッド・OpenSSL・fd）かエンジンに依存 | — |

## Host Filesystem を置き換える前に直す点
1. async の fs ジョブが使う非公開の検査（`authorize_access`、`remove`、`rename`、`write_entry`、`metadata_at`、`entry_metadata_at`）は `filesystem` の中からしか呼べない。スタブの `filesystem/job/mod.rs` をその橋渡しにする（`src/domains/policy/WIRING.md` §3.2）。
2. 書き込みでは上流はゲストのバイト列を検査の後に復号する。境界に「復号失敗: メッセージ」を渡せる入力を用意し、拒否が先に勝つ順序を保つ。
3. ポリシー wasm（約 470KB）が `__moonbit_fs_unstable` を使う全プログラムで要るようになる。コンパイルは約 1ms なので受け入れるか、legacy fs を別 crate に分ける。

## 構成
- `crates/` を 1 つの Cargo workspace にし、ロックファイルは moon の `Cargo.lock` に揃える（toml などの版がずれるとエラー文言が変わる）。共有の支援 crate: `os`（std の OS 呼び出しを host import に置き換えたもの）、`libc`（Linux/x86_64 の構造体配置と定数の偽物）、`tempfile`、`moonutil`（一部）。
- 読み込むタイミングごとに 1 つの wasm: `moonrun-policy`（`--policy`・継承ポリシー・legacy fs）、`moonrun-diag`（trap とサニタイザ）、`moonrun-cli`。`tls-engine` も workspace に入れる。
- `scripts/sync-upstream.ts`: `upstream.lock.json` の pin とファイル一覧から `git show <pin>:<path>` で `crates/<crate>/upstream/<path>` に取り出し（コミットする）、書き換え規則を適用して件数を検査し、件数が変わったら失敗する。`--check` を CI で回す。
- 許す書き換えは機械的なものだけ: `std::os::(unix|fd)::` → `crate::os::…`、`std::fs::…` → `crate::os::fs::…`、`std::env::…` → `crate::os::env::…`、`Path::new(x).{is_file,is_dir,exists}()` → `crate::os::path::…`。`eprintln!` は shim 側のマクロで host の stderr に送る。
- `build-wasm.ts`（`build-tls.ts` と同じ形）: ビルド済み `.wasm` をコミットし、import を許可リストと照合する。
- 境界は tls-engine と同じ C ABI（`*_alloc`/`*_free`、結果は `*_result_ptr`/`_len` で読む、状態はモジュール内、Linux errno、エラー連鎖は JSON 配列）。

## 罠
- wasm32-unknown-unknown では std の OS 呼び出しがコンパイルは通り、実行時に黙って失敗する（`Err(Unsupported)` や `false`）。LTO で消えるので wasm の名前からは見つからない。ソースの走査で書き換え漏れを検出する。
- `io::Error::from_raw_os_error(n)` の表示は "operation successful (os error n)" になる。shim は host の strerror の文言でエラーを作る（代わりに `raw_os_error()` は None）。
- `#[path]` を inline の `mod` の中で使うと、ディレクトリが実在する必要がある。
- shim から呼べるのは `pub(crate)`/`pub(super)` の項目だけ。
