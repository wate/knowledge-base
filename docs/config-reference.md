設定リファレンス
=========================

設定ファイル
-------------------------

ナレッジベースの設定は `config.yaml` で管理する。

### 設定優先順位

設定値の解決は以下の優先順位で行う(番号が小さいほど優先)。

| 優先順位 | ソース       | 例                                           |
| -------- | ------------ | -------------------------------------------- |
| 1        | CLI引数      | `--source-dir ../docs`                       |
| 2        | config.yaml  | 設定ファイルに明示的に書かれた値             |
| 3        | 環境変数     | `KNOWLEDGE_BASE_DB_PATH=/path/to/db`         |
| 4        | デフォルト値 | 各スクリプトに組み込まれた初期値(後方互換用) |

### 環境変数一覧

| 環境変数                         | 対応設定項目             | デフォルト値                         |
| -------------------------------- | ------------------------ | ------------------------------------ |
| `KNOWLEDGE_BASE_DB_PATH`         | `database.path`          | `knowledge-base.duckdb`              |
| `KNOWLEDGE_BASE_DICT_DIR`        | `dictionary.system_dir`  | `dict/lindera-ipadic`                |
| `KNOWLEDGE_BASE_USER_DICT_PATH`  | `dictionary.user_dict`   | `dict/user_dictionary/user-dict.bin` |
| `KNOWLEDGE_BASE_EMBEDDING_MODEL` | `embedding.model`        | `intfloat/multilingual-e5-small`     |
| `KNOWLEDGE_BASE_TOP_N`           | `search.top_n_documents` | `10`                                 |

### パス解決

`config.yaml` 内の相対パスは**ワーキングディレクトリ(プロセスカレント)**基準で絶対パスに解決する。
設定ファイルがconfig/配下など奥にある場合も、ワーキングディレクトリからの相対パスで記述する。

設定セクション一覧
-------------------------

### `source_dirs`

解析対象ディレクトリの一覧。`ingest` と `unknown_word_detection` で共通のデフォルトとして使用される。

```yaml
source_dirs:
  - ../docs
```

- CLI引数 `--source-dir` で上書き可能
- 各機能の設定(例: `unknown_word_detection.source_dirs`)で個別に上書きすることも可能

### `database`

DuckDBデータベースファイルのパス。

```yaml
database:
  path: knowledge-base.duckdb
```

- `path`: DBファイルのパス(ワーキングディレクトリからの相対パス、または絶対パス)

### `dictionary`

Lindera形態素解析エンジンの辞書設定。

```yaml
dictionary:
  system_dir: dict/lindera-ipadic
  user_dict: dict/user_dictionary/user-dict.bin
```

- `system_dir`: 標準辞書ディレクトリ(IPADIC)
- `user_dict`: ユーザー辞書ファイル(.bin)。存在しない場合は読み込まれない

辞書が存在しない場合、`lib/lindera.mjs` の `ensureDictionary()` によりGitHub Releasesから自動ダウンロードされる。

### `ingest`

ドキュメント取り込みパイプラインの設定。

```yaml
ingest:
  min_heading_level: 3
  exclude_patterns:
    - node_modules/**
    - .git/**
    - vendor/**
```

- `min_heading_level`: チャプター分割の最小見出しレベル
- `exclude_patterns`: 取り込み時に除外するディレクトリ/ファイルのglobパターン

### `embedding`

ベクトル化(embedding)の設定。

```yaml
embedding:
  model: intfloat/multilingual-e5-small
  dimensions: 384
  batch_size: 32
```

- `model`: HuggingFaceのembeddingモデル名
- `dimensions`: 出力ベクトルの次元数
- `batch_size`: バッチサイズ

### `chapter`

章立て設定。

```yaml
chapter:
  min_heading_level: 3
```

- `min_heading_level`: チャプターとして扱う最小見出しレベル

### `search`

検索スコア計算の設定。

```yaml
search:
  top_n_documents: 10
  weights:
    cosine: 0.5
    pagerank: 0.2
    heading: 0.2
    position: 0.1
  hybrid_weights:
    vector: 0.7
    bm25: 0.3
```

- `top_n_documents`: 2段階検索の第1段階で取得する上位N件
- `weights`: ベクトル検索スコアの内訳(合計が1.0になるように設定)
    - `cosine`: コサイン類似度の重み
    - `pagerank`: PageRankスコアの重み
    - `heading`: 見出しレベル重みの重み
    - `position`: 出現位置の重み
- `hybrid_weights`: ハイブリッド検索時の合算係数
    - `vector`: ベクトルスコア(上記weightsの合算値)
    - `bm25`: BM25スコア

### `heading_weights`

見出しレベルごとの重み。

```yaml
heading_weights:
  1: 9.0
  2: 6.0
  3: 3.0
  4: 2.0
  5: 1.5
  6: 1.0
```

- キー: 見出しレベル(1〜6)
- 値: そのレベルのチャプターに適用する重み

### `unknown_word_detection`

未知語検出の設定(Phase 2以降で拡張予定)。

```yaml
unknown_word_detection:
  source_dirs:
  filters:
```

- `source_dirs`: 解析対象ディレクトリ。未指定時は上位の `source_dirs` を使用
- `filters`: ノイズフィルタ設定(未実装、スケルトン)

### `pipeline`

変換後処理パイプラインの設定(Phase 3で実装予定)。

```yaml
pipeline:
  post_process:
```

- `post_process`: 各ソース種別の変換後に実行する後処理スクリプトの設定(未実装、スケルトン)

CLI引数とconfig.yamlの対応関係
------------------------------

| CLI引数             | config.yaml のキー                                  | 影響スクリプト                        |
| ------------------- | --------------------------------------------------- | ------------------------------------- |
| `--source-dir`      | `source_dirs`, `unknown_word_detection.source_dirs` | detect-unk.mjs                        |
| `--limit`           | (CLI専用)                                           | detect-unk.mjs, update-embeddings.mjs |
| `--force`           | (CLI専用)                                           | update-embeddings.mjs                 |
| `--vector`          | (CLI専用: 検索モード切替)                           | search.mjs                            |
| `--hybrid`          | (CLI専用: 検索モード切替)                           | search.mjs                            |
| `--top`             | `search.top_n_documents`                            | search.mjs                            |
| `--detailed` / `-D` | (CLI専用: 出力形式切替)                             | export-user-dict.mjs                  |
