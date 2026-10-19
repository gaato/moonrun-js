# 本家 moonrun との既知の差

差分テストの正規化はここに載っている ID だけを根拠にする。

| ID | 内容 | 理由 |
|---|---|---|
| D1 | 匿名 wasm 関数のフレーム `wasm://wasm/<hash>` のハッシュ値が異なる | V8 のバージョン差（moonrun は rusty_v8 0.106）。MoonBit の関数は名前付きなので通常は出ない |
| D2 | Suspending な import を使うモジュールは JSPI の副スタックで走るため、再帰の上限が本家より深い | JSPI の仕様。`--stack-size` は副スタックにも適用する |
| D3 | Bun 1.4.2（JSC）は wasm フレームの名前・関数番号・オフセットを公開せず、`at unknown` だけを返す。ソース位置・memory-sanitizer の allocation stack を復元できず、LinkError 等のエンジン文言も V8 と異なる。`unreachable` の文言は合わせている | エンジン差。stderr の比較ではフレーム名・位置とエンジン文言の正規化が必要。ただし core の例外検査や test-driver の失敗文は **stdout** にスタックを含むため、stderr だけを正規化する L2 にも届かない（両 target とも 90/131 invocation 一致、全テストの合否は一致）。stdout を削る正規化は行わない |
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
| D33 | Deno 2.9.7 / Bun 1.4.2 の `setMulticastTTL(0)` は IPv4/IPv6 とも `EINVAL`（Linux は 0 を許す）。async の `multicast_test.mbt` index 3 が失敗する | ランタイムの node:dgram が 1..255 に制限する。成功したふりや TTL=1 への置き換えはしない |
| D34 | Deno 2.9.7 の接続済み UDP の `address()` は、peer が loopback でもローカル IP を `0.0.0.0` と返す（送信元は実際には `127.0.0.1`）。`getsockname_test.mbt` index 1 が失敗する | Deno の UDP connect は実ソケットの connect ではなく宛先を保持する実装。公開 API から実際の経路選択後のローカル IP を取得できず、peer から推測しない |
| D35 | Deno 2.9.7 では UDP の send を直後の setsockopt が追い越す。multicast loopback を無効にする前の送信も届かず、`multicast_test.mbt` index 2 / 4 が失敗する | node:dgram の送信は非同期で、Linux の同期 send/setsockopt の順序を表せない。close については送信 callback まで待つことでデータ消失を修正済み。setsockopt を無条件に成功扱いして遅延することはしない |
| D36 | Deno 2.9.7 の node:net listener は `ipv6Only: true` でも IPv4-mapped 接続を受け入れる。`dual_stack_test.mbt` index 1 が失敗する | ランタイムの listen 実装の制約。受け入れた後に切断しても connect 時の `ECONNREFUSED` と同じにはならない |
| D37 | Bun 1.4.2 の native `wasm:js-string.equals("hello", null)` が 0 でなく `RuntimeError: Illegal argument` を返す。`backends/js-string-builtins` が exit 1 になる | native builtin の挙動で、解決済み import は JS から上書きできない。native builtins を全面無効にすると GC array 用 builtin を実装できず、別の正常な wasm を壊すため回避しない |
| D38 | Deno に `fromCompiled` で外部の `WebAssembly.Module` だけを渡した場合、匿名フレームの関数番号が常に 0 のままになる。bytes 経由の `compileBytes` と CLI ではコード位置から正しい番号に復元する | Module API は code section を取り出せない。名前付きフレームは影響なし。D1 のハッシュ差は別途残る |
| D39 | Deno 2.9.7 の ctime は秒単位（`stat` / `fstat` の `ctimeNs` 下 9 桁が 0）。mtime / atime も ns でなく ms 精度。`timestamp_test.mbt` index 0 の「600ms 後の ctime 差が 500ms 超」は秒境界によって失敗する | node:fs と Deno.stat の両方で確認。ホスト API に無い精度を時刻の推測で補わない |

P6 の測定上の注意:

- D12 の並行順序は、async/shell が起動する複数の `moon build` の stderr にも現れる。本家同士でも duplicate-import warning の断片が混ざる。`--refresh-ref` でビルドキャッシュ由来の `ran N tasks` は除けるが、断片の混在はなお変動する。**これをホストの不具合や L3 達成とは数えず**、raw stderr の不一致として報告する。warning の削除・無条件の stderr 正規化はしていない。
- Deno の watcher は inode ごとに共有し、`/proc/self/fd` 経由で監視する。移動時には現在のパスで再登録する（D17）。再登録の隙間の通知までは保証できない。既存の async/fs 50 テストと rename 後の子エントリ変更の回帰テストは一致する。
- D17 の通知の遅延・合流によって、Deno の watcher テストの 150ms ごとの観測は変動する（同じ修正後に fs は 44〜50/50 を観測）。単独の成功例だけで L3 達成とは判断しない。D39 の ctime もテスト成功数を変動させる。
- suite の旧 43 invocation は、外側の 27 wasm 呼び出しに子 runner の記録が混ざった値。同じ argv・異なる stdin の子の記録を上書きし、キャンセルのタイミングでも件数が変わっていた。P6 では外側の 27 呼び出しだけを比較する。子の観測可能な出力は親の stdout/stderr とゲストの検査に含まれ、比較対象から消えていない。
