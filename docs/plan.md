# moonrun-js: moonrun の TypeScript 別実装

## Context

MoonBit の `moonrun`（toolchain 同梱の wasm ランナー、Rust + V8）を TypeScript で再実装し、moonrun で動く任意の wasm（例: skills.mooncakes.io のスキル）を Node / Deno / Bun / ブラウザで動かす。ゴールは**本家 moonrun との互換**（同じ wasm で stdout/stderr/exit が一致）であり、特定デモではない。スキルのブラウザ実行デモは将来の応用で本計画の範囲外。workerd は専用 workaround を入れず、標準的な作りで動く範囲を最後に確認・記録するだけ。

調査で分かった前提:
- 公開スキルは linear memory の `--target wasm`。HTTPS もゲスト内（`moonbitlang/async/http`）で実装され、ホストは POSIX 風 import（TCP・epoll 風 `event_bus/wait`・スレッドプール・メモリバッファ型 TLS・getaddrinfo ジョブ）を約 100 本使う。
- moonrun の import 面: legacy（`spectest` / `__moonbit_{fs,time,sys,io,rand}_unstable` / `exception` / `ffi-bytes` / `moonbitlang/core` / memory-sanitizer）、WASI preview1（18 関数限定）、`moonbitlang/async`（約 256〜340）、`moonbitlang/sqlite`（約 40）。参照元 `~/ghq/github.com/moonbitlang/moon/crates/moonrun`（以下 `$MR`）。
- moonrun は全面同期で、ブロックするのは `event_bus/wait` だけ → JSPI なら `WebAssembly.Suspending` 1〜2 箇所 + `promising(_start)` で足りる。
- Node 24.21 / 26.11、Deno 2.9.7、Bun 1.4.2 で Wasm GC・exnref・js-string builtins・JSPI を実測確認。Chrome 137+ / Firefox 153 / Safari 27 も JSPI 出荷済み。
- `moon` は `MOONRUN_OVERRIDE` で moonrun を差し替えられる（`crates/moonutil/src/binaries.rs:213`）→ core / x / async のテストスイートを互換テストとして丸ごと使える。
- 完全な先行実装はなし（最も近いのは mizchi/kagura の wasm ホスト）。

## 確定する設計判断（後戻りしにくいもの）

1. **互換の基準は installed moonrun `0.1.20261012 (748b63c)`**。参照 clone を main の最新にした後も、生成・参照は `git show 748b63c:crates/moonrun/...` で基準 commit から行い、`upstream/moon`・`upstream/async`（shallow submodule、gitlink が pin）で commit を固定し、読み出しは `scripts/upstream.ts` に集約。
2. **常に Linux として振る舞う**: `get_platform`=Linux、`is_windows`=0。errno / strerror / `EAI_*` / sockaddr / stat 構造体は固定の Linux テーブル（`os.constants` は使わない）。`*/windows`・macOS 専用の "fake" import は呼ばれたら throw するスタブ。
3. **JSPI 必須**。Asyncify・Worker+Atomics の代替経路は作らない（ポート interface は `T | Promise<T>` にしておき将来の余地だけ残す）。対象は Node ≥ 24、Deno、Bun、現行ブラウザ。Node 22 は切る。
4. **仮想カーネルは JS が持つ**: WASI も `node:wasi` を使わず自前、ハンドル・poller・スレッドプール・パイプは TS の状態機械。
5. **TLS は rustls を wasm にしたもの**をホスト内の第 2 インスタンスとして同期で駆動（§TLS）。
6. **async / sqlite の import 表は moonrun の `declare_async_imports!` / `declare_sqlite_imports!` からコード生成**し、上流追従もこれで行う。
7. 1 パッケージ（npm 名 `moonrun-js`、bin も `moonrun-js`。`moonrun` とは名乗らない）+ 同一 repo 内の Rust crate（TLS）。**TS 以外の部品は「npm で自然に配布でき、動くホストを狭めないもの」に限る**: TLS エンジンはビルド済み `tls-engine.wasm`（WASI も wasm-bindgen も無し、Wasm GC すら不要）を npm パッケージに同梱し、利用者に Rust は要らない（必要なのは repo からビルドする開発者だけ）。SQLite は S8 の結果に従い、同じ版・設定の SQLite 3.53.2 を自前ビルドした `sqlite-engine.wasm`。ネイティブアドオン（`.node`）は動くホストを狭めるので使わない。部品の wasm も `WebAssembly.Module` で差し込めるオプションを用意する（ゲストの `Engine.load(Module)` と同じ汎用 API）。

## アーキテクチャ

```
CLI (hosts/node/cli.ts)    `--version` は `moonrun-js <版> (compat moonrun 0.1.20261012 748b63c)` 形式。argv（moon の実際の呼び方: [--test-args J] [--policy P [--policy-source-dir D]] <wasm> -- args）、--stack-size 時の再 exec、シグナル、exit
Engine / Run (engine/)     bytes|Module の読込、import 構築、JSPI 包み、テストドライバ、終了セル、結果分類、診断
ABI 層 (abi/)              ゲストから見える数値・文字列をすべてここで決める: ptr/len/BigInt ハンドル、-1+errno、番兵、Linux 構造体、moonrun と同一のエラーテキスト
Kernel + Domains           kernel: HandleTable, Resource, Poller, ThreadPool/Job/Worker, CompletionSource, Pipe, Signals, Termination
                           domains: Env, Stdio, Fs(+policy), Net(+policy), Process(+policy), Tls, Sqlite, Clock, Random(ChaCha12), Sanitizer
Ports (ports/*.ts)         型だけ。Stdio/Fs/Net/Dns/Process/Clock/Random/TrustStore/Signal/TlsEngine/Sqlite。失敗は HostError{code:'ENOENT'|…}
Host adapters              hosts/node（Deno・Bun も node: 互換で共用、差が出たら個別化）| hosts/browser（P7）
```

- コア（engine/abi/kernel/domains/ports）は `node:*` を import しない。Biome `noRestrictedImports` と browser バンドル検査で強制。
- ゲストメモリは import 呼び出しごとに `memory.buffer` から view を作る（memory.grow / サスペンド後の detach 対策。モジュールレベルの view を lint で禁止）。memory は instantiate 後に bind（start 関数中の import はメモリ不可、moonrun と同じ）。
- import 構築: `WebAssembly.Module.imports()` の各項目を静的表（legacy / WASI / 生成 async / 生成 sqlite）で引く。未知 import は moonrun と同じ "failed to instantiate" 文言。js-string builtins は native 優先、無ければ `wasm:js-string` 関数と `_` 定数を通常 import として渡す（`$MR/src/wasmtime/mod.rs:255-267,342-567` と同方式）。`Engine.load` は `WebAssembly.Module` も受け取る。
- `Suspending` で包むのは `suspends` 指定の import（`event_bus/wait`、exit 系）と、そのホストで非同期なポート（ブラウザの OPFS 等）だけ。

レイアウト:
```
src/{index.ts, generated/(手編集禁止), engine/(wasm-sections.ts = 型照合用パーサ を含む), diagnostics/(render, demangle, source-map, stack-v8/jsc/sm), abi/(legacy/*, wasi/preview1.ts, async/generated.ts + 各 family, sqlite/), kernel/, domains/, ports/, hosts/node/}
crates/tls-engine/   scripts/{gen-imports,check-async-surface,build-tls,difftest,suite}.ts
test/{unit,wat,fixtures/mbt,conformance}   bin/{moonrun-js, moonrun-js-deno, moonrun-js-bun}
```

## 流用の原則（2026-10-19 追加）

moonrun の Rust ソースのうち OS に触らない論理部分（ポリシー、WASI の検査ロジック、結果のエンコード、デマングル等）は、基準 commit のファイルをそのまま wasm32-unknown-unknown に取り込んで使うのを既定にする。TS で書くのは OS 相当の層（仮想カーネル、ホストのアダプタ、JSPI まわり）と、流用モジュールとの境界だけ。理由: 他人が定義した挙動を TS で再現するより、上流への追従が機械的になる。どのモジュールを置き換えるかは調査結果（docs/reuse.md）で決める。

## 壊れにくさと保守性のための原則（型と構造）

壊れ方として想定するのは主に 3 つ: (1) 上流の import 面が変わる、(2) 境界の数値の取り違え（ptr と len、u32 と u64、errno の符号）、(3) ランタイム差によるホスト側の差。これを型と構造で防ぐ。

**依存方向は一方向**: `engine → abi → domains → kernel → ports ← hosts`。逆向き import は dependency-cruiser で CI エラー。hosts は ports の実装だけを持ち、コアは hosts を知らない。Biome の `noRestrictedImports` でコアから `node:*` を禁止。

**import 定義は宣言データ + 推論**:
- 各 import は `defineImport({ module, name, params: ['u64','u32','u32'], result: 'i32' }, (fd, ptr, len) => …)` で書く。引数型はシグネチャのタプルから推論（i32/u32→`number`、i64/u64→`bigint`、externref→`unknown`）。手で引数型を書かないので、シグネチャとハンドラの食い違いはコンパイルエラーになる。
- async / sqlite のシグネチャは `src/generated/`（moonrun の registry から生成、手編集禁止、CI で再生成して差分ゼロを確認）。ハンドラ表は `satisfies { [S in AsyncSymbol]: Handler<AsyncSig[S]> }` で、欠落も余計な実装もコンパイルエラー。
- **ロード時の自己検査**: JS API ではインポートの型が取れないので、wasm の type / import セクションだけ読む小さなパーサを持ち、ゲストの宣言する関数型と自分の表を照合する。上流が型を変えたら、実行中の謎のクラッシュではなく「`moonbitlang/async.xxx` の型が (i64,i32)->i32 で表と違う」とロード時に明示エラーで分かる。

**境界の値はブランド型**: `GuestPtr`・`GuestLen`（`number` のブランド）、`Handle`（`bigint` のブランド）、`Errno`（Linux errno の名前付き定数のユニオン）。生の `number` / `bigint` からの変換は ABI 層の 1 箇所でだけ行う。

**ゲストメモリは `GuestMemory` 経由のみ**: `read(ptr, len)` / `write(ptr, bytes)` / `u32(ptr)` などが毎回 `memory.buffer` から view を作り、範囲外は `EFAULT`。生の `ArrayBuffer` は外に出さない（memory.grow とサスペンドによる detach をまとめて防ぐ）。

**構造体は宣言的なレイアウト 1 つから**: `sockaddr_in`、`sockaddr_in6`、stat 結果、FileTime、wait status は、`struct({ family: u16, port: u16be, addr: bytes(4) })` のようなレイアウト定義からエンコーダ、デコーダ、サイズ（`ipv4_addr_size` 等の戻り値）を導出する。サイズとオフセットの二重管理をしない。

**失敗は層ごとに型で表す**:
- ports と domains は throw せず、`Result<T, HostError>` を返す（`HostError` は `{ code: 'ENOENT' | 'EAGAIN' | … }` の判別ユニオン）。
- ABI 層だけが、それを moonrun の流儀（`-1` + errno、`-3` 等のステータス、ホストエラーとしての throw）に変換する。
- 実行結果は `RunOutcome = { kind: 'completed' } | { kind: 'exited', code } | { kind: 'trap', diagnostic } | { kind: 'host-error', message } | { kind: 'signaled', signal }`。ライブラリは `process.exit` を呼ばず、CLI だけが `RunOutcome` を終了コードに写す。

**状態機械は判別ユニオン + 網羅検査**: ソケット（`unconnected | connecting | open | half-closed | closed | error`）、ジョブ、ワーカー、パイプ端の状態は `kind` 付きユニオンで持ち、`switch` の末尾は `assertNever`。状態に関係ないフィールドを持てないようにする。

**グローバル状態なし**: すべての状態は `Run` オブジェクト（HandleTable、Poller、ThreadPool、TerminationCell…）にぶら下げる。同一プロセスで複数 Run を並行実行できる（moonrun の `test_concurrent_http_instances` 相当）。

**能力は明示的に注入**: `createEngine({ host })` の `host` はポートの束。ないポート（ブラウザの Process 等）は `undefined` ではなく `unsupported` 実装を渡し、呼ばれたら `ENOSYS` 相当で一貫して失敗させる。`?.` で黙って素通りさせない。

**tsconfig を最も厳しく**: `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noPropertyAccessFromIndexSignature`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、公開 API は `isolatedDeclarations`。Biome で `noExplicitAny`・`noNonNullAssertion` をエラーにする。

**変わりやすい部分を隔離**:
- 旧版 async 向けの compat import は `abi/async/compat.ts` に集め、まとめて落とせるようにする。
- 本家との意図的な差は `docs/divergences.md` に ID 付きで列挙する（rustls の文言、Node の bind=listen 等）。差分テストの正規化はこの ID を参照し、根拠のない正規化を足せないようにする。

**テストで構造を守る**:
- **ポートの契約テスト**: 同じテスト群を各実装（Node アダプタ、メモリ VFS、偽ポート）に流し、差し替えられることを保証する。
- **カーネル状態機械のプロパティテスト**（fast-check）: パイプ、poller の edge、completion の再 arm、キャンセルを、単純なモデルと照合する。

## async 設計（単一スレッド JS + JSPI）

ゲスト側の契約（`~/ghq/github.com/moonbitlang/async/src/internal/event_loop/*.wasm.mbt`, `epoll.c`）: edge-triggered（EPOLLIN|EPOLLET|EPOLLRDHUP）、`event_events` は ERR|HUP|RDHUP→3 / IN=1 / OUT=2、イベントバッファ 1024、`try_register` は 1/0（regular file）/-1、`fetch_completion` は非ブロック、`cancel_worker_with_retry` は 0 Retry / 1 NeedWait / 2 Done。

- **HandleTable**: 世代付き u64（境界では BigInt）、全種類で 1 名前空間（ADR 0009）、0/1/2 は stdio。null ハンドル値は本家で実測して合わせる。
- **Poller**: 登録時に既に ready なら即 edge。`wait`: pending があれば同期で返す（スタック切替なし）／timeout 0 で空なら 1 macrotask 待って再確認／それ以外は edge か timeout で resolve（-1 の間は ref 付きハンドルを保持して Node の exit 13 を防ぐ）。約 5ms ごとに強制 yield。
- **ThreadPool**: `make_*_job` は入力を即コピー、Worker は `{state, job, AbortController}`、完了で ret/err を書き CompletionSource に edge（キュー残があれば再 arm）。結果のゲストメモリ書き込みは `get_*_result` 時のみ（ADR 0004/0006/0007）。キャンセル: 公開済み→2 / abort 可能（sleep・wait_for_process・socket/pipe/stdin read・getaddrinfo・connect）→abort して 1 / 不可（fs）→0。
- **ソケット（node:net/dgram/dns）**: connect は `-1/EINPROGRESS`、connect で OUT edge、error で pendingErrno + edge 3。read はキューから、空なら EAGAIN、end で IN|HUP。write は `writableNeedDrain` なら EAGAIN、drain で OUT。`allowHalfOpen:true`。bind+listen は Node の制約上 bind ジョブで listen まで行う（乖離として記録）。DNS は `dns.lookup(all, verbatim)` + glibc 文言。
- **パイプ**: 64KiB リングバッファ、EAGAIN / EOF / EPIPE。`spawn_worker_with_pipe` は `PipeCompletionNotifier` のエンコードを移植。
- **プロセス**: `child_process.spawn`、stdio は ignore/fd/inherit/pipe 中継（背圧あり）、wait は Linux wait status にエンコード。
- **シグナル**: ゲストが登録した間だけ `process.on(SIG*)`、ビットマスクで合流、CompletionSource で job より先に排出。
- **終了**: 最初の exit が勝つ TerminationCell。promising 内では exit import が永久 pending の Promise を返してゲストを凍結し、runner は `race([export, terminated])`。start 関数中は sentinel を throw。各呼び出し後に例外分類より先にセルを確認。teardown で worker abort・ソケット破棄・stdio flush。
- **stdio**: Node では `fs.writeSync(1|2)` / `fs.readSync(0)` + EAGAIN リトライ（`process.stdout/stdin` は触らない）。async ゲストの stdin は非同期 read ジョブ（読み取り中はキャンセル不可、EAGAIN の再試行待ちは中断可能）。

## TLS

契約（`$MR/src/async_host/tls/openssl.rs:180-440`）: 呼び出しごとに入力暗号文スライスと出力スライス、`bytes_read`/`bytes_to_write`、溢れた出力は内部保持して `wants_write`、戻り値 0/-1/-2/-3/-4、`shutdown` はフラグだけ、trust 0=検証なし / 1=システムルート / 2=指定ルートのみ、host 空なら SNI もホスト名検証もなし、サーバ側（`set_server_files`/`set_server_pfx`/`accept`/`peer_certificate`/channel binding）も対象。

- **rustls（buffered `ClientConnection`/`ServerConnection`）を `wasm32-unknown-unknown` の cdylib に**（`crates/tls-engine`、wasm-bindgen なし、約 600 行の C-ABI）。ホストから `now_unix_ms` と `random_fill` を import。provider は `ring`（clang 必要）、ダメなら `rustls-rustcrypto`。`opt-level=z` + LTO + `wasm-opt -Oz` で 1MB 未満目標。Run ごとに 1 インスタンス、ゲストのスライスを同期コピー。
- 却下: pure-JS TLS（TLS1.3 なし / SubtleCrypto が非同期）、実ソケット側で TLS（fd 対応付けが推測頼み）、Node TLSSocket + 偽 Duplex（非同期で would-block が定義できない）。
- ルート: Node は `tls.getCACertificates('system')` + `SSL_CERT_FILE/DIR`、フォールバック `tls.rootCertificates`。Deno/Bun は同 API か openssl-probe の候補パス（openSUSE `/etc/ssl/ca-bundle.pem` 等）。ブラウザは webpki-roots 同梱。
- 既知の乖離: OpenSSL のエラー文言（difftest で正規化）、`unique_channel_binding` は null（TLS1.3 では未定義）、TLS ≤1.1 非対応。

## 段階計画

**今回の承認範囲は P0〜P6**。各段の終了条件を満たしたら止まらず次へ進む。**例外は P0 の終了時**: スパイク結果で上記の確定判断（JSPI 前提・終了方式・TLS 方式など）が変わる場合だけ計画を直して再承認を取る。変わらなければ P1 以降は自走。外向き操作（GitHub repo 作成・npm publish）は直前に確認。

- **P0 スパイクと骨格**: 最初に参照 clone を更新する。moon と async は使い終わった fork ブランチ（`fix/registry-pull-pipe-deadlock`、`fix-close-wake-pending-io`、作業ツリーはクリーンで fork に push 済み）にいるので、`git switch main` で main に戻してから、4 つとも `ghq get -u` で最新にする。ローカルの fork ブランチは削除してよい（fork 側には残る）。続いて `jj git init --colocate`、`mise.toml`、Biome、vitest、tsdown、CLI 引数解析、wasm-gc hello world（`print_char`）。スパイク（各 30 行程度、結果は `docs/spikes.md`）:
  - S1 JSPI 再開後の trap でも `at NAME (…:0xOFF)` が取れるか（Node/Deno/Bun）
  - S2 Suspending import が非 Promise を返すとき切替が起きないか・1 呼び出しのコスト
  - S3 core/x/async/スキルの wasm に `catch_all` があるか、終了 sentinel / 永久 pending が設計通り効くか、凍結スタックが GC されるか、スタックが凍結されたままの teardown で問題が起きないか
  - S0 `moon test` / `moon run` が実際に `MOONRUN_OVERRIDE` のパスを起動するか（`crates/moonutil/src/binaries.rs:31,213` と `crates/moon/src/run/runtime.rs:85` でパス上書きであることは確認済み）、`moon version --all` が `--version` 出力をどう扱うか（`moonutil::version::get_moonrun_version`）
  - S4 `--stack-size`: `node --stack-size=N` 再 exec（Deno/Bun は `--v8-flags`）で JSPI 下の再帰深さを moonrun と比較
  - S5 js-string builtins / `importedStringConstants` の native 対応状況と polyfill の同一性
  - S6 Deno・Bun の `node:net`（pauseOnConnect / allowHalfOpen）、dgram、`dns.lookup(all)`、child_process の fd stdio、`tls.getCACertificates`、TTY/pipe/file 上の `readSync(0)`/`writeSync(1)`
  - S7 mise で rust + wasm32 target、rustls+ring を wasm でビルドしサイズ測定
  - S8（P5 まで後回し可）sqlite-wasm を JS VFS で Node 24 上で
  - 終了条件: 全スパイク回答済み、必要な設計変更を本計画に反映。
- **P1 コアランナー・legacy・診断・WASI**: engine、テストドライバ（half-open 範囲、最初の終了で停止、per-test trap は stdout に `----- BEGIN MOON TEST RESULT -----` ブロック）、結果分類（`RuntimeError`/`WebAssembly.Exception` だけがゲスト失敗、他は `Error: ` を 1 回剥がしてホストエラー）、`wasm_diagnostic.rs`/`moonutil demangle.rs`/`source_map.rs` の移植、legacy import 全部（`time.now` は BigInt、rand はリンクが通る実装を置き、rand 0.8 の seed_from_u64 + ChaCha12 + gen_range のビット一致はそれを要するテストが出たときに対応、ffi-bytes は専用 1 ページ memory、fs_unstable は `$MR/src/template/js_glue.js` と `filesystem/v8/*` を移植）、WASI 18 関数。
  - 終了条件: `MOONRUN_OVERRIDE=bin/moonrun-js` で pinned moonbitlang/core の `moon test --target wasm-gc` と `--target wasm` が本家と per-test で同じ合否・失敗メッセージ一致。x も async 依存以外で同様。moonrun の stack_trace / cli_args / read_bytes / current_exe / memory_sanitizer 系テストケース一致。cowsay スキル一致。
- **P2 async カーネル**: `scripts/gen-imports.ts`（Linux の `#[cfg]` 枝を採用し `{sym, params, result, kind}` と `AsyncHandlers` 型を生成。ハンドラ欠落はコンパイルエラー、fake は throw スタブ）、HandleTable / Poller / ThreadPool / CompletionSource / Pipe / sleep / fs ジョブ一式 / stdio / os_error / os_string / c_buffer / env_util / random / time / signal 登録 / compat import（ADR 0010）。
  - 終了条件: async の `--target wasm` スイートのうち socket/tls/http/websocket/process/signal 以外が per-test 一致。BigInt ハンドルのコストを計測。
- **P3 ネットワーク**: TCP/UDP、listen/accept、bind・getaddrinfo ジョブ、sockopt、getsockerr、gai_strerror。
  - 終了条件: async の socket テスト（localhost）一致、ローカル平文 HTTP サーバへの HTTP クライアント動作。
- **P4 TLS**: `crates/tls-engine` + ラッパ + ルート取得、次にサーバ側、最後に PFX。
  - 終了条件: async の TLS テスト（`test_keys/`）一致、実ホストへの HTTPS。**download.mooncakes.io の gaato/discord-cli と gaato/kbbi.mbt のビルド済み wasm が Node・Deno・Bun で本家と同じ stdout・exit**。
- **P5 プロセス・シグナル・SQLite・ポリシー**: spawn/wait（パイプ中継）、シグナル配送と signal 終了、sqlite（S8 の結果で sqlite-wasm + 同期 JS VFS か自前 wasi-sdk ビルドを選ぶ。`node:sqlite` は statement ハンドルが無いので不可）、`--policy` / `--policy-source-dir` / `MOONRUN_INHERITED_POLICY`（`$MR/src/policy/*.rs` 移植）、`MOONBIT_ASYNC_CHECK_FD_LEAK`。
  - ポリシーの読み込み（TOML/JSON/`.mbtx` の解析と検証）は、moonrun の `policy/config.rs` を基準 commit から取り込んだ小さな Rust wasm（`crates/policy-config`）への置き換えを組み込み時に行う。理由: 上流で変更が多く（2026-08〜10 で 15 回）、serde_json/toml/serde_yaml のエラー文言を TS でまねるより追従が機械的になる。判定ロジックは上流の変更箇所を見て、Rust 側に寄せるかを決める。デマングル・ソースマップは変更が少ないので TS のまま。
  - 終了条件: async スイート全体が一致、moonrun の sqlite / policy 系テストケース一致。
- **P6 マルチランタイム仕上げ**: JSC・SpiderMonkey のスタック解析、必要なら Deno/Bun 専用アダプタ。互換レベル L0 exit / L1 stdout / L2 stderr（正規化）/ L3 バイト一致。
  - 終了条件: V8 系（Node・Deno・Chromium）は core と async で L3、Bun（JSC）は L2。
  - **2026-10-19: part 2 のレビューを反映。公開 API のみで実装し、Deno / Bun の未達は乖離として残す**。共有 node: ホストの callback・Dirent・watcher・UDP close、Deno の匿名フレーム、JSC stack parser、SQLite の Result と生成表ハンドラ型共有、pin 済み CI は part 1 で完了。
  - part 2: async の結果行を block 内も多重集合比較し、nested moon helper を事前 build・出力を子ごとに転送して shell stderr の断片混在を解消。Node 全 async は **27/27・546/546 を 3 回連続**。Bun の native js-string equals(null) を局所的に補正し、GC-array builtin は保持する。
  - レビューで libc dlopen / FFI と runtime-private fd への依存を撤去。設計判断 7 の「動くホストを狭めない」に従い、ホストは公開 API を使う。TTL=0（D33）、Deno の UDP addressing / ordering（D34 / D35）、IPv6-only listener（D36）、時刻精度（D39）を未解消の乖離として記録。watcher は D17、受信 peer の IPv6 scope ID 欠落は D40。これらを stdout 正規化で隠さない。
  - Node/Deno の core は wasm・wasm-gc とも L3、131/131。Bun は各 41 invocation の **stdout** に JSC が公開しない stack 名が入り、D3 の stderr 正規化後も 90/131。全 core テストの合否と exit は一致。stdout を消す正規化で L2 達成とはしない。
  - Bun conformance は 32 mismatch を分類し、28 stderr-only を D3 の限定正規化、1 stderr+exit を D37 の修正で解消。3 stdout-only は理由付きで残す（105/3/0/3）。Node/Deno は 108/3/0/0。CLI 22/22、live skills 6/6 は全 runtime で維持。
  - nightly の既知の差で新しい regression を見落とさないよう、`test/conformance/expected-differences.json` で runtime / invocation / test / target ごとの期待差分を固定。既定で読み、未登録の差と必須差分の消失は両方失敗にする。D39 の ctime だけは flaky を許す。既知差分だけなら CI は成功するが、raw 一致数と互換レベルの未達は変わらない。
  - suite の母数は子 runner の重複記録を除いた外側の 27 invocation。使う正規化の ID は D1・D3・D5・D12。Deno の外部 Module-only は D38 / Bun は D37、公開 API の制約は D33–D36・D39・D40 を参照。残る差を `docs/divergences.md` に記録し、終了条件の未達を明示する。
- **P7 ブラウザホスト（2026-10-19 実装、Chrome の実測は coordinator 待ち）**:
  - `moonrun-js/browser`: Web API のみの Host、非同期 component 準備、専用 module Worker と `runInWorker`。メモリ VFS は preload / fd / symlink / SQLite の同期 I/O を扱う。OPFS は対象外。
  - 偽 IP DNS と TCP client の WebSocket 中継。TLS は rustls wasm 内、roots は localhost relay の host store。process / UDP / listen / watch は ENOSYS、signal capture は既存の inert convention。D41–D44 に差を記録。
  - `mise exec -- pnpm demo:browser` でビルドと localhost デモを起動。relay は token / same-origin / Host 検査と正確な接続先許可リストを持つ開発専用 script（ws は devDependency）。
  - VFS / DNS / relay / guest / Worker の Node テストと browser bundle の依存・asset 検査を追加。ブラウザを使った検証は行わない。[利用方法・protocol・期待される skills](browser.md)。
  - 自動検証: typecheck / lint / build（browser の node:・bare import と asset 検査を含む）成功、unit 422 passed / 1 skipped、moonrun-tests **108/3/0/0**、core wasm **131/131**（7874 tests 成功）。ログは `.cache/p7-*.log`。
  - workerd の専用コードや検証はこの作業に含めない。

## P6 の測定結果（2026-10-19）

全コマンドを `mise exec --` 経由で実行。FFI 撤去後のログ・conformance JSON・suite JSON と async 反復記録は `.cache/p6-public-api/` に保存。`.cache/p6-part2/` の FFI 使用時の数値は現行実装の互換結果に含めない。suite の通常のレポート先は `.cache/reports/`。part 1 の測定は `.cache/p6/before/`・`.cache/p6/after/`。conformance の列は identical / known / pending / mismatch。Bun の stderr は D3、async の結果順だけは指定された `--unordered`（D12）で比較する。

| 検証 | Node 26.11.1 | Deno 2.9.7 | Bun 1.4.2 |
|---|---:|---:|---:|
| core wasm: 一致 invocation | 131/131 | 131/131 | 90/131 |
| core wasm: 成功テスト | 7874/7874 | 7874/7874 | 7874/7874 |
| core wasm-gc: 一致 invocation | 131/131 | 131/131 | 90/131 |
| core wasm-gc: 成功テスト | 7894/7894 | 7894/7894 | 7894/7894 |
| moonrun-tests.json | 108/3/0/0 | 108/3/0/0 | 105/3/0/3 |
| cli-argv.json | 22/22 | 22/22 | 22/22 |
| skills.json（live） | 6/6 | 6/6 | 6/6 |
| async 全体: 一致 invocation | 27/27（3 回連続） | 25/27 → 26/27 → 26/27 | 26/27 |
| async 全体: 成功テスト | 546/546（3 回とも） | 540/546 → 541/546 → 541/546 | 545/546 |

Deno は各回で socket が 20/25（D33–D36 の 5 件）、fs が 49/50 → 50/50 → 50/50。変動したのは `timestamp_test.mbt` index 0（D39）だけ。watcher テストは今回の 3 回とも成功したが、一般的な fs.watch の合流・遅延や再登録の隙間までは保証しない（D17）。D40 の IPv6 peer scope 欠落は D33 の後ろに隠れるため、独立した失敗数に加えない。Bun は socket の TTL=0（D33）だけが失敗する。Bun の残る conformance 3 件と core の各 41 件は stdout の stack 文だけで、exit / ゲストの合否は一致する。分類と正規化の境界は `docs/divergences.md` を参照。

パッケージ別（part 1 の全 package 測定に、公開 API のみの全体再実行を反映。成功テスト数、一致 invocation は括弧内）:

| async パッケージ | Deno | Bun |
|---|---:|---:|
| fs | 49/50 (0/1) → 50/50 (1/1) → 50/50 (1/1) | 50/50 (1/1) |
| socket | 20/25 (0/1; D33–D36) | 24/25 (0/1; D33) |
| tls | 8/8 (1/1) | 8/8 (1/1) |
| http | 55/55 (2/2) | 55/55 (2/2) |
| process | 39/39 (2/2) | 39/39 (2/2) |
| signal | 5/5 (1/1) | 5/5 (1/1) |
| shell | 76/76 (2/2) | 76/76 (2/2) |
| stdio | 1/1 (1/1) | 1/1 (1/1) |
| websocket | 27/27 (2/2) | 27/27 (2/2) |
| pipe | 3/3 (1/1) | 3/3 (1/1) |

`pnpm typecheck`・`pnpm lint`（層チェック含む）は成功。`pnpm test` は **25 files / 405 passed / 1 skipped**（任意の live TLS）。SQLite ABI は既存の 9/9。回帰テストは protocol 行の順序・重複・message 保持、nested moon の全出力と失敗 status、3 runtime の nullable js-string + native GC-array・未知 import 保持、watcher の rename と UDP close を確認する。FFI の timestamp / socket 動作に依存する 6 tests は実装の撤去に合わせて除いた。期待差分の照合・新しい差・解消済みの差・重複・fingerprint・flaky 制約の回帰テストを追加した。

期待差分の導入後、node / deno / bun の core wasm・wasm-gc・async の **9 コマンドが全て exit 0**。raw 一致数は上表の通りで、Deno async の今回の値は 26/27、D39 は発生しなかった。実際に照合した ID は D3・D33–D36。Bun の D33 の項目を削った一覧では unexpected=1 / exit 1、同一の Node array test に必須の期待差分を加えた一覧では missingExpected=1 / exit 1 を確認した。ログ・JSON は `.cache/expected-differences/`。既定で一覧を読むので workflow の変更は不要。

CI は part 1 で追加済み（push/PR の型・lint・unit・Node wasm-gc smoke、schedule/dispatch の node 24 / node 26 / deno / bun matrix）。MoonBit は `moonbit-version` と mise の moonup で固定。GitHub 上の実行や公開は行っていない。

初期測定は Deno fs 9/50、Bun fs 22/50、Deno socket / 全 async は timeout。part 1 では socket が Deno 20/25、Bun 24/25、ctime / watcher が不安定だった。レビュー後の公開 API のみの再測定結果は上表の通り。FFI 使用時の 545/546（Deno）・546/546（Bun）は現行結果ではない。最終測定に socket の EPERM や stdin 待ち timeout は無い。abort の core dump timeout は差分テストの子だけ core dump を無効にして解消済み（SIGABRT の比較は維持）。

## テスト戦略

- **unit（vitest, Node）**: ABI エンコーダ、Linux errno/strerror 表、ChaCha12 と gen_range のベクタ（本家から負の seed を含めて採取）、demangle（`demangle.rs` のテストから移植）、source map、スタック解析（V8/JSC/SM の `.stack` 実例）、カーネル状態機械（edge、再 arm、キャンセル表、パイプ EOF/EPIPE）を偽ポートで。
- **`.wat` fixture**（`wasm-tools parse` でテスト時に組み立て、`.wasm` はコミットしない）: start 中の import、未知 import、各 trap、exception tag、import 中の memory.grow、js-string、start 中 / `_start` 中の exit。
- **MoonBit fixture**: `test/fixtures/mbt/<case>/` を pin した moon でビルド（`_build/` は gitignore、内容ハッシュでキャッシュ）。`$MR/tests/test_cases/*.in` を移植。
- **差分ランナー `scripts/difftest.ts`**: `(wasm, argv, stdin, env, cwd, policy)` を本家 `moonrun` と `moonrun-js` で実行し `{stdout, stderr, exit}` を比較（一時パス・時刻・pid・TLS エラー文言を正規化）、JSON レポート。
- **スイートランナー `scripts/suite.ts`**: core / x / async を repo 内の gitignore 済みディレクトリ（`.cache/upstream/`）に pin した commit で別途 shallow clone し（`~/ghq/github.com/moonbitlang/*` の作業 clone は触らない）、そこで `MOONRUN_OVERRIDE=… moon test --target wasm|wasm-gc`、本家で記録したベースラインと per-test 比較。
- **CI（GitHub Actions）**: PR では lint・型・unit・Node の core wasm-gc スモーク。nightly で {Node 24, 26, Deno, Bun} × {core wasm/wasm-gc, async, スキル}。
- **上流追従**: `scripts/check-async-surface.ts` が pin と最新 main の async `*.wasm.mbt` の import が生成表に揃っているか検査。nightly で `git log <pin>..origin/main -- crates/moonrun` を見て新規があれば issue。pin 更新はスイートが通ってから。

## ツール

mise（node 24/26, deno, bun, pnpm, rust + wasm32-unknown-unknown, wasm-tools, binaryen, moonup で moon を pin）、pnpm 10（単一パッケージ）、TypeScript（`erasableSyntaxOnly`。開発中は Node の型ストリップで `src` を直接実行、型検査は `tsc --noEmit`）、tsdown（ESM + d.ts、エントリ core/node/cli、P7 で browser）、TLS wasm は `new URL('./tls-engine.wasm', import.meta.url)` で読む、vitest + fast-check、Biome、dependency-cruiser（層の依存方向）。npm `moonrun-js`（`engines.node >= 24`）。jj colocated、main 直 push。AGENTS.md は短く、この計画と spikes.md を指すだけ。

## 主なリスク

| リスク | 対処 | 時期 |
|---|---|---|
| JSPI の細部（再開後のスタック形、同期戻りで切替なしか、exnref とサスペンド） | S1–S3 | P0 |
| JSPI 副スタックで再帰深さが本家と違う（core に再帰重いテスト） | S4、V8 フラグで再 exec | P0/P1 |
| 永久 pending の終了で Node が exit 13 | ref 付きハンドル保持 + race | P1 |
| stdio の EAGAIN・順序 | writeSync/readSync + リトライ、process.stdout 不使用 | P1 |
| BigInt i64 のコスト | P2 で計測（境界の BigInt は変えられない） | P2 |
| 基準のずれと async import の変動 | submodule の pin、pin 済み `git show` から生成（`scripts/upstream.ts`）、nightly 検査 | 全期間 |
| rust wasm ツールチェーン / ring の getrandom | S7、rustls-rustcrypto に退避 | P4 |
| Node の bind=listen、Deno/Bun の半閉じ | S6、乖離として文書化 | P3 |
| SQLite の VFS と版の一致 | S8、自前 wasi-sdk ビルドも候補 | P5 |
| rustls と OpenSSL の差（文言・tls-unique・旧 TLS） | 乖離として文書化、差分正規化 | P4 |

## 主要参照ファイル

- `$MR/src/async_api/registry.rs`（生成元。748b63c で読む）
- `$MR/src/async_host/mod.rs`（poller・worker・completion・TLS ホスト）、`$MR/CONTEXT.md`、`$MR/docs/adr/0001..0011`
- `$MR/src/v8/mod.rs`、`$MR/src/engine.rs`（実行フロー・エラー分類・テストドライバ）
- `$MR/src/v8/host_imports.rs`、`$MR/src/template/js_glue.js`（legacy 面）、`$MR/src/v8/wasi.rs`、`$MR/src/wasi/mod.rs`
- `$MR/src/async_host/tls/openssl.rs`（TLS 契約）
- `~/ghq/github.com/moonbitlang/async/src/internal/event_loop/{thread_pool.wasm.mbt,epoll.c}`（ゲスト側の契約）
- `$MR/tests/`（移植するテストケース）、`crates/moon/src/run/runtime.rs:84-103`（moon の呼び出し argv）

## 検証（end-to-end）

1. `scripts/suite.ts` で core（wasm/wasm-gc）・x・async の per-test 結果が本家ベースラインと一致（P1/P2/P5 の各終了条件）。
2. `scripts/difftest.ts` で moonrun の test_cases、cowsay、discord-cli、kbbi を本家と比較（stdout/stderr/exit）。
3. 手動確認例（fish）: `MOONRUN_OVERRIDE=(pwd)/bin/moonrun-js moon test --target wasm -C ~/ghq/github.com/moonbitlang/async`、`bin/moonrun-js ~/.moon/registry/cache/assets/gaato/kbbi/…/kbbi.wasm -- <語>` と本家 `moonrun` の出力を diff。
4. nightly CI の Node/Deno/Bun マトリクスが緑。
