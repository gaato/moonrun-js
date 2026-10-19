# 本家 moonrun との既知の差

差分テストの正規化はここに載っている ID だけを根拠にする。

| ID | 内容 | 理由 |
|---|---|---|
| D1 | 匿名 wasm 関数のフレーム `wasm://wasm/<hash>` のハッシュ値が異なる | V8 のバージョン差（moonrun は rusty_v8 0.106）。MoonBit の関数は名前付きなので通常は出ない |
| D2 | Suspending な import を使うモジュールは JSPI の副スタックで走るため、再帰の上限が本家より深い | JSPI の仕様。`--stack-size` は副スタックにも適用する |
| D3 | Bun 1.4.2（JSC）は wasm フレームの名前・関数番号・オフセットを公開せず、`at unknown` だけを返す。ソース位置・memory-sanitizer の allocation stack を復元できない。LinkError / CompileError のエンジン文言も V8 と異なる | stderr は `scripts/comparison.ts` でフレームの名前・位置だけを置換（行数・字下げは保持）。invalid wasm magic と callable import の文言だけを同義の形に揃え、import の module:name は保持する。任意のエラー文は消さない。core の例外検査と test-driver の失敗文は **stdout** にスタックを含むため、L2 にも届かない。stdout の正規化はしない。両 target とも 90/131 invocation、全テストの合否・exit は一致 |
| D4 | WASI のパス引数（`path_open` 等）が UTF-8 として不正なバイト列のとき、U+FFFD に置き換えたパスで OS を呼ぶ（本家は Unix で生バイトのまま渡す）。`fd_readdir`・`path_readlink` が返す名前は生バイトで一致 | ホストのパスを文字列で扱うため。MoonBit の String 由来のパスは常に UTF-8 |
| D5 | `--version` と `--help` は moonrun-js として名乗る（`moonrun-js <版> (compat moonrun …)`） | 別実装であることを隠さない。`moon version --all` は出力をそのまま表示するだけなので影響なし |
| D6 | `wasm:js-string` builtin の中で trap したとき、本家のスタックには builtin のフレーム（例 `at fromCodePoint`）が 1 行多い | V8 のバージョン差。新しい V8 は builtin をインライン化してフレームを出さない |
| D7 | async の Worker は JS のイベントループ上で動く。同期で済む Job（stdio write、失敗 Job 等）は開始した import の中で完了する。stdin read はホストの非同期 I/O で待つため Run を止めない | 仮想カーネルを JS で持つ設計。`run_job` は JSPI で完了まで待つ（従来の D10 は解消） |
| D8 | stdio ハンドルは poll できない（`try_register` は 0、旧 `register` は `EPERM`）。登録で stdio の blocking モードを変えない（本家は pipe/tty の stdin を epoll に登録し `O_NONBLOCK` にする） | 埋め込み元プロセスの fd の状態を変えないため。moonbitlang/async は stdio を `is_async: false`（thread pool 経由）で使うので到達しない |
| D9 | `io/read/unix`・`io/write/unix` を blocking なパイプ端に使い、ブロックするはずのときは `EAGAIN` を返す（本家は Run ごと永久にブロックする） | 単一スレッドではブロックできない。正しいゲストは async な端か Job を使う |
| D11 | パイプは 64KiB のバイト列 + `PIPE_BUF`（4096）原子性でモデル化しており、満杯付近の nonblocking write が受け付けるバイト数が Linux のページ単位の実装と異なりうる | 実装の単純化。`EAGAIN`/`EPIPE`/EOF と readiness の意味は同じ |
| D12 | 同時に完了する Job・タイマーの観測順、およびシグナルと Job 完了が同時に保留中のときの `wait` のイベント数（本家は 2 つの fd、moonrun-js は 1 つの Completion Source）が異なりうる | タイミング依存。並行に走る async テストの結果行の順序は本家自身も実行ごとに変わる |
| D13 | 値やキーが UTF-8 として不正な環境変数は U+FFFD に置き換えた文字列として見える（本家の `get_env_var` は空文字列を返し、`get_env_vars` はその項目を飛ばす） | Node の `process.env` が置換済みの文字列しか渡さないため |
| D14 | パスで開いたファイル（FIFO・端末・文字デバイスを含む）は poll できない（`try_register` は 0）。読み書きは常に Job になり、ブロックする FIFO の open/read は取り消せずホストの I/O スレッドを 1 本占有する（本家は FIFO・端末を epoll に登録し、Job も `SIGUSR2` で中断できる） | Node は任意 fd の readiness を待てない。通常ファイル・ディレクトリ・`/dev/null` は本家でも epoll 不可（`EPERM`）で Job を使うので同じ |
| D15 | ホストの fd を持たない資源（`fd_util/pipe` のパイプ、Completion Source、inotify インスタンス、ソケット）への `fstatx` は種別（pipe / unknown / socket）とサイズ 0 だけが実値で、device・inode・時刻は 0。`fsync` は `EINVAL`、`flock` はその資源自身とだけ競合する | パイプとカーネル資源を JS で持っているため（計画「仮想カーネルは JS が持つ」） |
| D16 | `flock`（`fs/try_lock_file`・`make_flock_job`）は Run 内でエミュレートした advisory lock で、他プロセスや他の Run からは見えない。inode ごと・open file description ごとの共有/排他、変換時に先に解放する挙動、`EWOULDBLOCK`、待ちの `EINTR` 中断は Linux と同じ | Node に `flock` が無い |
| D17 | inotify は Node の `fs.watch`（Linux では inotify）でエミュレートする。イベントは名前なし（`len` 0）で、マスクは代表値（ディレクトリのエントリ変化は `IN_CREATE`、ファイルの書き込みは `IN_MODIFY`）。`IN_MODIFY` と `IN_ATTRIB` は mtime の変化で見分け、ディレクトリ自身の移動・削除もエントリ変化として報告する。`IN_IGNORED` は `remove_file` のときだけ出し、削除による自動解除は報告しない。`IN_Q_OVERFLOW` は出さない。watch はパスの `O_PATH` fd を持つ。watch 登録時（または直前に報告した書き込み）と同じ mtime の刻みに入った書き込みは `IN_ATTRIB` と区別できず落ちる | `fs.watch` は `change`/`rename` の 2 種しか区別しない。ゲスト（`@fs.Watcher`）は wd・relevant・ignore・overflow しか読まず、変化した wd を再走査して差分を出すので、余分な再走査は結果を変えない |
| D18 | `make_rename_job` の `replace=false`（`RENAME_NOREPLACE`）は移動先の `lstat` を見てから `rename` するので、その間に作られた移動先は置き換えられる | Node の `rename` にフラグが無い |
| D19 | `make_readdir_job` は `/proc/self/fd/<fd>` を `opendir` して `linux_dirent64` に詰め直す。`.`・`..` を先頭に置き、`d_off` は通し番号、`d_ino` はエントリの `lstat`。`/proc` の無いホストでは `ENOENT`。開いたまま削除されたディレクトリは本家が 0（終端）を返すのに対し `ENOENT` になる | Node に fd からの `getdents64` が無い。エントリ順は同じ `getdents64` 由来 |
| D20 | TLS は OpenSSL ではなく rustls で、`take_error` などのエラー文言が異なる。TLS 1.1 以下と再ネゴシエーションは非対応 | 同期で駆動でき、全ランタイムで動く TLS エンジンとして rustls を wasm で使うため |
| D21 | IP リテラルや DNS 名として不正なホストは SNI として送らない | rustls の `ServerName` の制約 |
| D22 | 自分自身が信頼済みルートではない `CA:TRUE` の leaf 証明書は、別のルートにつながっていても拒否する（OpenSSL は受け入れる） | rustls の検証規則。信頼済みルートと一致する leaf は受け入れる |
| D23 | 署名が SHA-224 の証明書では `server_endpoint_channel_binding` が unavailable になる | ring が SHA-224 を持たない |
| D24 | ホストに OpenSSL 形式の証明書の置き場所が無いとき、システムルートとして Node の同梱ストアを使う（本家は空） | 証明書が見つからない環境でも trust=1 を使えるようにするため |
| D25 | TCP の bind（`thread_pool/make_bind_job`・`socket/bind`）はホストで listen まで行う。bind 済みでゲストが `listen` する前の接続もホストが受け付けて保留し、bind 済みソケットの `connect` は `EISCONN`、listen 前の bind 済みソケットへの接続は拒否されない。TCP の listener には常に `SO_REUSEADDR` が付く（`allow_reuse_addr` は効果なし、TIME_WAIT の残るポートにも bind できる） | Node（libuv）の TCP には listen と切り離した bind が無く、`SO_REUSEADDR` も常に設定される |
| D26 | ソケットのバッファは JS 側で持つ。受信は 128KiB 溜まるとホストの読み込みを止め、送信はホストの high-water mark を超えるまで要求長を丸ごと受け付けて以後 `drain` まで `EAGAIN`（本家は `SO_SNDBUF` 内の部分書き込み）。UDP の受信は 212992 バイトを超えた分を捨てる。未 bind の UDP ソケットへの setsockopt は bind 時に順に適用し、bind 済みの UDP ソケットで接続先を変える `sendto` は `EISCONN`。`enable_keepalive` は idle だけを使い、回数と間隔はホスト既定。接続中の TCP ソケットの `getsockname` はワイルドカード。close 後にホスト側に残った未送信データは、その前にプロセスが終了すると失われる | 非同期のバイトストリーム（`node:net`/`node:dgram`）の上で Linux のソケットを模すため |
| D27 | `socket/bind`、未 bind の `socket/listen`、`socket/udp_client_connect`、未 bind の `socket/sendto/unix` はホストの完了までゲストを中断する（JSPI）。本家では即座に返る | ホストの bind/connect が非同期。中断中はゲストのコードが動かないので、違いは所要時間だけ |
| D28 | `getaddrinfo` はホストの解決器（Node は `dns.lookup`、`AI_ADDRCONFIG`）を使い、glibc と同じくアドレスごとに stream/dgram/raw の 3 項目を返す。Node は `EAI_NONAME` と `EAI_NODATA` を errno で区別するが、Bun など code だけのランタイムでは両方 `EAI_NONAME` になる。インターフェースの番号とフラグは `/sys/class/net` から読み、無いホストでは `os.networkInterfaces()` のリンクローカルの scope id と「up」とみなしたフラグを使う | `getaddrinfo`・`getifaddrs` を直接呼べない |
| D29 | `open_pid_handle` は Run が spawn した子に対して pidfd 相当のハンドルを返す。それ以外の存在する pid は invalid handle（errno 0）で waitpid ジョブにフォールバックするが、ホストの別コードが作った子は待てない | Node は任意 pid の pidfd / waitpid を公開しない |
| D30 | spawn の stdio に kernel socket / inotify / process / Completion Source を渡すと `EINVAL`。kernel pipe、stdio、開いたファイルは対応する | Node に手渡すホスト fd が無い資源は、パイプ以外中継していない |
| D31 | SQLite のロックは同じ Run の接続間でのみ有効。別プロセス・別 Run と同時に同じデータベースへ書く用途は非対応 | Node に POSIX record lock が無い。SQLite 3.53.2 自体と、同期 VFS・Run 内ロック表を使用する |
| D32 | Deno 2.9.7 の `opendir` は `encoding: 'buffer'` でも名前を文字列で返し、不正 UTF-8 の名前は U+FFFD に変わる。legacy の `read_dir` でも本家の「不正 UTF-8 を飛ばす」と異なりうる | opendir が生バイトを渡さず、readdir(buffer) も置換後の UTF-8 を返す（名前 0xff → ef bf bd を実測）。Bun の「Dirent でなく Buffer が返る」差はホスト層で吸収済み。通常の UTF-8 名は一致 |
| D33 | Deno 2.9.7 / Bun 1.4.2 の公開 `setMulticastTTL(0)` は IPv4/IPv6 とも `EINVAL`（Linux は 0 を許す）。async の IPv6 multicast discovery が失敗する | ランタイムの公開 API の制約。TTL=1 への置換や成功扱いはしない。libc の dlopen・FFI と runtime-private fd の取り出しは計画の設計判断 7 に反するため使用しない |
| D34 | Deno 2.9.7 の UDP connect は peer を保持するだけで、`address()` は経路選択後もワイルドカードを返す。`getsockname_test.mbt` index 1 が失敗する | 公開 API は経路選択後のローカル IP を返さない。peer からの推測や private fd による getsockname は行わない |
| D35 | Deno 2.9.7 の非同期 UDP send を直後の setsockopt が追い越す。multicast loopback を無効にする前の送信も届かず、`multicast_test.mbt` index 2 / 4 が失敗する | 公開 API だけでは Linux の同期 send/setsockopt の順序を保持できない。guest に成功を返した後で option を遅延することや private fd による同期 send は行わない。close の送信 callback 待ちは維持する |
| D36 | Deno 2.9.7 の node:net listener は `ipv6Only: true` でも IPv4-mapped 接続を受け入れる。`dual_stack_test.mbt` index 1 が失敗する | 公開 listen API の制約。受け入れ後の切断は connect 時の拒否と異なる。FFI で socket を作り直す経路は設けない |
| D37 | Bun 1.4.2 の native `wasm:js-string.equals("hello", null)` が 0 でなく trap する | **CLI / bytes 経由では解消**。動作を probe し、equals の import namespace だけを同じ長さの衝突しない内部名に差し替えて JS の equals を使う。GC-array の builtin・関数番号・ソースオフセットは維持する。入力 bytes は変更しない。外部の `WebAssembly.Module` だけを渡す `fromCompiled` では解決済み builtin を上書きできず、この制約が残る |
| D38 | Deno に `fromCompiled` で外部の `WebAssembly.Module` だけを渡した場合、匿名フレームの関数番号が常に 0 のままになる。bytes 経由の `compileBytes` と CLI ではコード位置から正しい番号に復元する | Module API は code section を取り出せない。名前付きフレームは影響なし。D1 のハッシュ差は別途残る |
| D39 | Deno 2.9.7 の ctime は秒単位、mtime / atime は ms 精度。`timestamp_test.mbt` index 0 の「600ms 後の ctime 差が 500ms 超」は秒境界によって失敗する | node:fs と Deno.stat の両方で確認。公開 API にない ns 精度を時刻の推測や libc の statx で補わない。mtime の刻みは watcher の変化検出（D17）にも影響する |
| D40 | Deno 2.9.7 の node:dgram は受信した IPv6 link-local peer の scope ID を失う | UDP receive bridge は hostname / port しか返さず、元の sockaddr の sin6_scope_id は復元できない。正しい scope を必要とする reconnect に影響する。送信先やローカルの interface から推測しない。上流の公開 API による scope 保持が必要。現在の multicast discovery テストは先に D33 で失敗するため、D40 を独立した失敗数として重複計上しない |

P6 の測定上の注意:

- D12: `--unordered` は protocol block 同士だけでなく、その中の result / start JSON 行も多重集合として比較する。重複・message・protocol 外の出力は保持する。signal の index 0 / 1 の入れ替わりを許すが、合否や出力を消さない。
- shell の warning の書き手は `src/shell/progs_for_test.mbt` の遅延初期化から並行起動する `moon build test_programs/{cat,sleep,dump_env,filter}`。同じ stderr に parser が warning を複数 write していた。suite は helper を事前 build し、nested moon の出力を子ごとに完全に捕捉してから転送する。warning のフィルタは無い。stdout・stderr・非ゼロ exit の転送を回帰テストで確認し、Node 全 async は **27/27、546/546 を 3 回連続**で観測した。
- Deno の watcher は inode ごとに共有し、`/proc/self/fd` 経由で監視する。移動時には現在のパスで再登録する（D17）。公開 API の mtime 精度（D39）、通知の合流・遅延、再登録の隙間があるため、単独の fs 50/50 だけでは安定した一致と数えない。FFI 撤去後の全 async 3 回では watcher テストは全成功、ctime だけが 1 回失敗した（D39）。成功テスト数は 540 → 541 → 541 / 546、socket の 5 失敗は各回で同じ。
- suite の旧 43 invocation は、外側の 27 wasm 呼び出しに子 runner の記録が混ざった値。同じ argv・異なる stdin の子の記録を上書きし、キャンセルのタイミングでも件数が変わっていた。P6 では外側の 27 呼び出しだけを比較する。子の観測可能な出力は親の stdout/stderr とゲストの検査に含まれ、比較対象から消えていない。

Bun の分類（part 1 → part 2）:

| 対象 | part 1 の差 | part 2 の扱い |
|---|---|---|
| moonrun-tests: 28 cases | stderr のみ | D3 の正規化で一致。エラー文・フレーム数・exit は保持 |
| moonrun-tests: `backends/js-string-builtins` | stderr + exit | D37 の実装修正で完全一致（null の両向き比較と GC-array builtin を回帰テスト） |
| moonrun-tests: `stack/test-block-closure`, `stack/test-block-method`, `outcomes/test-execute-trap` | stdout のみ | D3 の stack が stdout の失敗 message に入る。3 mismatch として残し、exit は一致 |
| core wasm / wasm-gc: 各 41 invocations | **すべて stdout**（例外の文字列検査）、stderr-only / exit 差は 0 | JSC の位置・関数番号が無く名前を復元できない。各 90/131 一致、7874/7874・7894/7894 tests の合否は一致 |

比較に使う divergence ID は **D1**（匿名 wasm hash）、**D3**（Bun stderr の上記限定正規化）、**D5**（明示した CLI case の usage 名）、**D12**（`--unordered`）。D6 は既知の差として報告するだけで正規化しない。D17・D33–D36・D39・D40 や stdout の stack を無条件に同じ扱いにはしない。レポートは Bun の正規化前の fields も `rawFields` に記録する。

CI の期待差分:

- `scripts/suite.ts` は既定で `test/conformance/expected-differences.json` を読む。`--expected-differences <json>` で別の一覧を指定できる。runtime・suite・target・wasm invocation と test file/index を限定し、ID がこの表にあることを検証する。`-p` の指定時はその package の期待差分だけを検査する。
- 一覧には現在の Bun core の D3（各 target 41 invocations / 340 test records）、Deno async の D33–D36（1 invocation / 5 tests）、Bun async の D33（1 test）を登録した。D39 の ctime test だけは `flaky: true` で出ても出なくてもよい。任意の差を flaky にすることは許さない。D17 / D40 は期待差分に入れていない。
- fingerprint は reference / actual の **両方**の result record を固定する。D3 はフレームの名前・位置だけを除き、フレーム数・エラー文・全ての他のフィールドを保持する（JSC の divide/remainder by zero 等の文言も固定）。D34 は message 内で同一であることを確認した loopback / wildcard の port だけを可変とする。異なる port の組み合わせや別のエラーは一致しない。
- 一覧と異なる出力・新しい test の差・exit / signal / stderr の差は失敗。必須の期待差分が無くなっても失敗し、解消済みの項目の更新を要求する。既存の D3 stderr / D12 順序の正規化は継続する。列挙した result record 以外の stdout は変更しない。
- exit 0 は「差が全て登録通り」であり、互換レベル L2 / L3 の達成ではない。raw の一致 invocation 数と `mismatches` を残し、`expected` / `unexpected` / `missingExpected` と実際に一致した divergence ID を別に報告する。
