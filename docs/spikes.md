# P0 スパイク結果（2026-10-19）

対象: Node 26.11.1 / 24.21.0、Deno 2.9.7、Bun 1.4.2。スクリプトは `spikes/` にある（`.wat` は `wasm-tools parse` で組み立てて引数に渡す）。

## S0 MOONRUN_OVERRIDE
- `moon test` / `moon run` / `moon version --all` はすべて `MOONRUN_OVERRIDE` のパスを起動する（パス上書き）。
- moon の呼び方: `moonrun --test-args <json> <wasm> --` / `moonrun <wasm> -- <args>`。`moon version --all` は `--version` の出力をそのまま表示するだけ。
- per-test trap はホストが `----- BEGIN MOON TEST RESULT -----` ブロックを書く。`start` と通常の `result` はゲストが書く。

## S1 JSPI 再開後のスタック
- V8 系（Node・Deno）: 再開後の trap も `at NAME (wasm://wasm/<hash>:wasm-function[N]:0xOFF)` が取れる。Deno は関数番号が 0 になるがオフセットは正しい（moonrun はオフセットしか使わない）。
- 下端に `at async file:///…` が付く → wasm 以外のフレームは捨てる。
- Bun（JSC）: `at unknown` だけでオフセットなし、trap メッセージも別文言（`Unreachable code should not be executed`）→ Bun は L2 止まり（計画どおり）。
- `promising` 外で Suspending を呼ぶと `SuspendError`。

## S2 Suspending のコスト
- 同期 import 約 7ns/呼び出し。Suspending で非 Promise を返すと V8 約 100ns、Bun 約 600ns。
- → Suspending で包むのは本当に待つ import（`event_bus/wait` 等）だけ。

## S3 例外処理命令と終了方式
- 公開スキル 24 本と MoonBit 出力に `try_table` / `catch` / `catch_all` は無い（abort は import した `exception.throw` を呼ぶだけ）。ゲストは JS 例外を捕まえられない。
- **設計変更（簡素化）**: exit 系 import は「永久 pending で凍結」ではなく、終了セルに記録してから専用の例外を throw する。`promising` に依存しないので、Suspending を使わないモジュールでも同じ経路になる。各呼び出し後、例外分類より先に終了セルを見る（moonrun の `invoke` と同じ順）。
- 将来 `catch_all` を含むモジュールが来た場合への備え: ロード時に命令を走査はしない。終了セルが立った後にゲストが戻ってきても結果は終了扱い（記録したコードが勝つ）。

## S4 スタックの深さ
- main スタックの再帰深さは Node 15.7k / Deno 16.2k フレーム（V8 既定 `--stack-size=984`）。JSPI の副スタック上では 145k〜151k と深い。Bun はどちらも 638k。
- moonrun は `--stack-size` を V8 の `--stack-size` に渡すだけ。
- **方針**: Suspending な import を持たないモジュールは `promising` を使わず main スタックで直接呼ぶ（本家と同じ深さ）。async モジュールは副スタックで走るので深さが本家と異なる（divergence として記録）。`--stack-size` は CLI が `node --stack-size=N --wasm-stack-switching-stack-size=N` で再 exec する。

## S5 js-string builtins
- 4 ランタイムとも `{builtins:['js-string'], importedStringConstants:'_'}` を native 対応。native で解決された import は `WebAssembly.Module.imports()` から消える。
- **方針**: 常にオプション付きでコンパイルし、`imports()` に残った `wasm:js-string` / `_` だけを polyfill で埋める（渡された `WebAssembly.Module` にも同じ処理）。

## S6 Deno・Bun の node: 互換
- net（pauseOnConnect、allowHalfOpen、writableNeedDrain、drain、半閉じ、IPv6、ECONNREFUSED）、dgram、`dns.lookup(all, verbatim)`、child_process（fd stdio、ENOENT、kill）、`fs.readSync(0)` / `writeSync(1)`、シグナル、`Atomics.wait` は 4 ランタイムで同一。
- 差異: `tls.getCACertificates('system')` は Deno・Bun でシステムストアを読まない（121 本の同梱版）。Bun の `dns` エラーの `errno` が正の 4（`.code` は同じ）→ `.code` で判定する。
- **方針**: trust=1 のシステムルートは OpenSSL と同じ探索（`SSL_CERT_FILE` / `SSL_CERT_DIR` / 既知のパス）を自前で行う。

## S7 rustls → wasm32-unknown-unknown
- rustls 0.23.46 + ring 0.17.14 が RPM の rust 1.98 と clang 23 でビルドでき、Node から example.com / google.com に検証付き HTTPS で `200 OK`。期限切れ・未知ルートは拒否。
- サイズ: `wasm-opt -Oz` 後 481KB（gzip 206KB）、webpki-roots 込みで 540KB。import は `env.now_unix_ms` と `env.random_fill` だけ。
- 罠: ring の wasm32-unknown 向け RNG と rustls-pki-types の `UnixTime::now()` に 1 行パッチが要る（`[patch.crates-io]`）。`wasm-opt --all-features` は Node が読めない符号化を出すので `--enable-*` を列挙する。`#[link(wasm_import_module = "env")]` が必要。
- P4 の課題: パッチを減らす（rustls の `CryptoProvider.secure_random` 差し替え等で回避できるか確認）。

## S8 SQLite
- P5 に後回し。

## 確定判断への影響
- JSPI 前提・Linux 振る舞い・TLS 方式・コード生成方針は変更なし。
- 変更は終了方式の簡素化（凍結 → throw）と promising を使う条件の明確化のみ。
