graphology-pagerankの移行
=========================

概要
-------------------------

依存パッケージ `graphology-pagerank` を、後継の `graphology-metrics` が提供するPageRankへ移行します。

背景・理由
-------------------------

`graphology-pagerank@1.1.0` はメンテナンスが終了しており、`yarn install` 時にメンテナンス終了の警告が出ます。
警告では代替として `graphology-metrics/centrality/pagerank` が案内されています。

現状は動作していますが、今後の更新は望めないため後継パッケージへ移行します。

前提条件・制約事項
-------------------------

- `pagerank_score` は `lib/search.mjs` のスコア計算で使うため、移行前後で値の傾向を維持する
- 現在の計算条件(減衰係数`0.85`・最大`100`反復・許容誤差`1e-6`)を維持する
- 実行環境はNode.js v24以上で、実装はJavaScript(`.mjs`)とする

詳細
-------------------------

1. 依存を差し替える
    - `package.json` の `graphology-pagerank`(`^1.1.0`)を削除し、`graphology-metrics`(`^2.4.2`)を追加する
2. `lib/update-pagerank.mjs` を変更する
    - import先を `graphology-metrics/centrality/pagerank` へ差し替える
    - 呼び出しオプションの `damping` を `alpha` へ変更する(`maxIterations`・`tolerance` は同名)
    - 戻り値はノードIDとスコアの対応オブジェクトのため、スコアの書き込み処理は変更不要とする
3. 移行前後で `documents.pagerank_score` を比較する
    - `ORDER BY pagerank_score DESC LIMIT 10` の並びとスコア分布が大きく変わらないことを確認する
4. 動作確認する
    - `zx knowledge-base.mjs update-pagerank` を実行し、スコアが更新されることを確認する
    - `npm test` を実行する

期待する成果物
-------------------------

- `graphology-pagerank` への依存が無くなり、`yarn install` 時のメンテナンス終了警告が消える
- `update-pagerank` が移行前と同等の `pagerank_score` を書き込む
- 既存テスト(`npm test`)が通る

参考情報
-------------------------

### 関連ドキュメント

- [アーキテクチャ設計書](../../docs/architecture.md): PageRankの位置づけと計算式を確認する
- [検索方式](../../docs/search.md): `pagerank_score` の使われ方を確認する
- [DBスキーマ定義](../../docs/schema.sql): `documents.pagerank_score` の定義を確認する

### その他の参考情報

- 移行の根拠は `yarn install` 時に表示される警告です
- PageRank関数は `graphology-metrics/centrality/pagerank` が提供する
- オプションの既定値は `alpha 0.85`・`maxIterations 100`・`tolerance 1e-6` で、現行の指定と一致する
- 通常呼び出しはノードIDとスコアの対応オブジェクトを返し、`pagerank.assign()` はノード属性へ代入する
- 重み属性の無いエッジは重み`1`として扱われるため、現行コード(重み無し)の挙動は変わらない
- ピア依存は `graphology-types`(型定義のみ)で、実行時の依存は増えない

関連ファイル
-------------------------
