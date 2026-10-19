# 本家 moonrun との既知の差

差分テストの正規化はここに載っている ID だけを根拠にする。

| ID | 内容 | 理由 |
|---|---|---|
| D1 | 匿名 wasm 関数のフレーム `wasm://wasm/<hash>` のハッシュ値が異なる | V8 のバージョン差（moonrun は rusty_v8 0.106）。MoonBit の関数は名前付きなので通常は出ない |
| D2 | Suspending な import を使うモジュールは JSPI の副スタックで走るため、再帰の上限が本家より深い | JSPI の仕様。`--stack-size` は副スタックにも適用する |
| D3 | Bun（JSC）では trap の文言とスタックの形が V8 と異なる（フレームのオフセットが取れない） | エンジン差。Bun は L2 互換 |
| D4 | WASI のパス引数（`path_open` 等）が UTF-8 として不正なバイト列のとき、U+FFFD に置き換えたパスで OS を呼ぶ（本家は Unix で生バイトのまま渡す）。`fd_readdir`・`path_readlink` が返す名前は生バイトで一致 | ホストのパスを文字列で扱うため。MoonBit の String 由来のパスは常に UTF-8 |
