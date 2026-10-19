# 本家 moonrun との既知の差

差分テストの正規化はここに載っている ID だけを根拠にする。

| ID | 内容 | 理由 |
|---|---|---|
| D1 | 匿名 wasm 関数のフレーム `wasm://wasm/<hash>` のハッシュ値が異なる | V8 のバージョン差（moonrun は rusty_v8 0.106）。MoonBit の関数は名前付きなので通常は出ない |
| D2 | Suspending な import を使うモジュールは JSPI の副スタックで走るため、再帰の上限が本家より深い | JSPI の仕様。`--stack-size` は副スタックにも適用する |
| D3 | Bun（JSC）では trap の文言とスタックの形が V8 と異なる（フレームのオフセットが取れない） | エンジン差。Bun は L2 互換 |
| D4 | WASI のパス引数（`path_open` 等）が UTF-8 として不正なバイト列のとき、U+FFFD に置き換えたパスで OS を呼ぶ（本家は Unix で生バイトのまま渡す）。`fd_readdir`・`path_readlink` が返す名前は生バイトで一致 | ホストのパスを文字列で扱うため。MoonBit の String 由来のパスは常に UTF-8 |
| D5 | `--version` と `--help` は moonrun-js として名乗る（`moonrun-js <版> (compat moonrun …)`） | 別実装であることを隠さない。`moon version --all` は出力をそのまま表示するだけなので影響なし |
| D6 | `wasm:js-string` builtin の中で trap したとき、本家のスタックには builtin のフレーム（例 `at fromCodePoint`）が 1 行多い | V8 のバージョン差。新しい V8 は builtin をインライン化してフレームを出さない |
| D7 | async の Worker は JS のイベントループ上で動く。同期で済む Job（stdio の read/write、失敗 Job）は開始した import の中で完了し、stdin の read Job はホストの stdin がブロックする間 Run 全体を止める（本家は Worker スレッドだけが止まる） | スレッドを使わない設計（計画の「仮想カーネルは JS が持つ」）。完了はどちらも次の `event_bus/wait` で観測される |
| D8 | stdio ハンドルは poll できない（`try_register` は 0、旧 `register` は `EPERM`）。登録で stdio の blocking モードを変えない（本家は pipe/tty の stdin を epoll に登録し `O_NONBLOCK` にする） | 埋め込み元プロセスの fd の状態を変えないため。moonbitlang/async は stdio を `is_async: false`（thread pool 経由）で使うので到達しない |
| D9 | `io/read/unix`・`io/write/unix` を blocking なパイプ端に使い、ブロックするはずのときは `EAGAIN` を返す（本家は Run ごと永久にブロックする） | 単一スレッドではブロックできない。正しいゲストは async な端か Job を使う |
| D10 | 待つ Job（sleep、ブロック中のパイプ I/O）への `thread_pool/run_job` はすぐ戻り、結果は Job が終わった時点で見えるようになる（本家はゲストのスレッドで完了まで待つ） | 同上。現行の moonbitlang/async は `run_job` を呼ばない |
| D11 | パイプは 64KiB のバイト列 + `PIPE_BUF`（4096）原子性でモデル化しており、満杯付近の nonblocking write が受け付けるバイト数が Linux のページ単位の実装と異なりうる | 実装の単純化。`EAGAIN`/`EPIPE`/EOF と readiness の意味は同じ |
| D12 | 同時に完了する Job・タイマーの観測順、およびシグナルと Job 完了が同時に保留中のときの `wait` のイベント数（本家は 2 つの fd、moonrun-js は 1 つの Completion Source）が異なりうる | タイミング依存。並行に走る async テストの結果行の順序は本家自身も実行ごとに変わる |
