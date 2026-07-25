設定リファレンス
=========================

設定ファイル
-------------------------

ナレッジベースの設定はプロジェクトルートの `.knowledge-base.yml` で管理する。
サンプル設定は[config.sample.yml](config.sample.yml)を参照。

### 設定優先順位

設定値の解決は以下の優先順位で行う(番号が小さいほど優先)。

| 優先順位 | ソース              | 例                                           |
| -------- | ------------------- | -------------------------------------------- |
| 1        | CLI引数             | `--source-dir docs`                          |
| 2        | .knowledge-base.yml | 設定ファイルに明示的に書かれた値             |
| 3        | 環境変数            | `KNOWLEDGE_BASE_DB_PATH=/path/to/db`         |
| 4        | デフォルト値        | 各スクリプトに組み込まれた初期値(後方互換用) |

### 環境変数一覧

| 環境変数                         | 対応設定項目             | デフォルト値                             |
| -------------------------------- | ------------------------ | ---------------------------------------- |
| `KNOWLEDGE_BASE_DB_PATH`         | `database.path`          | `knowledge-base.duckdb`                  |
| `KNOWLEDGE_BASE_DICT_DIR`        | `dictionary.system_dir`  | `knowledge-base/dict/system`             |
| `KNOWLEDGE_BASE_USER_DICT_PATH`  | `dictionary.user_dict`   | `knowledge-base/dict/user/user-dict.bin` |
| `KNOWLEDGE_BASE_EMBEDDING_MODEL` | `embedding.model`        | `intfloat/multilingual-e5-small`         |
| `KNOWLEDGE_BASE_TOP_N`           | `search.top_n_documents` | `10`                                     |

### パス解決

`.knowledge-base.yml` 内の相対パスは**ワーキングディレクトリ(プロセスカレント)**基準で絶対パスに解決する。
npm scriptsを `knowledge-base/` から実行する場合はパスの先頭に `knowledge-base/` を付けず、カレントディレクトリからの相対パスで記述する。

設定セクション一覧
-------------------------

### `sources`

データ取得元の一覧。collect.mjsがこの設定を読み取り、全ソースを統一的に処理する。

```yaml
sources:
  - docs                          # ショートハンド: ローカルディレクトリ
  - http://example.com/           # ショートハンド: Web URL
  - source: http://redmine.example.com/
    type: redmine
    auth:
      api_key: "xxxxx"           # typeごとの認証情報
```

#### ショートハンド自動判別ルール

- `http://`/`https://` 始まり → `type: web`(HTTP取得)
- それ以外 → `type: local`(ファイルパスまたはディレクトリ)

#### 詳細形式のフィールド

- `source`: 実際の取得先(URL orファイルパス)
- `type`: source plugin名(local/web/Redmine/github...)
- `auth`: typeごとの認証情報
- `excludes`: local typeのみ、個別の除外ディレクトリ(グローバルの `source_local.exclude_patterns` を上書き)

### `source_local`

ローカルソースのディレクトリスキャンに関する設定。

```yaml
source_local:
  exclude_patterns:
    - node_modules/**
    - .git/**
    - vendor/**
```

- `exclude_patterns`: ディレクトリスキャン時に除外するディレクトリ名。個別の設定がなければこのリストを使用する

### 外部キー制約に関する注意

`docs/architecture.md`の「外部キー制約に関する注意」を参照。

DuckDB v1.5.4の「Over-Eager Constraint Checking in Foreign Keys」制限のため、`sources`テーブルの`document_id`カラムからFK制約を除去している。代わりに`idx_sources_document_id`インデックスで性能を確保。

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
  type: ipadic
  system_dir: dict/system
  user_dict: dict/user/user-dict.bin
```

- `type`: 辞書種別(`ipadic`/`unidic`/`ko-dic`...)。`system_dir` に配置する辞書の種類を指定
- `system_dir`: システム辞書ディレクトリ。固定パスで、`type` の切り替え時は同じディレクトリに上書き配置する
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
  cache_dir: tmp/models
```

- `model`: HuggingFaceのembeddingモデル名
- `dimensions`: 出力ベクトルの次元数
- `batch_size`: バッチサイズ
- `cache_dir`: モデルキャッシュディレクトリ(ワーキングディレクトリからの相対パス、デフォルト: `tmp/models`)

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

- `source_dirs`: 解析対象ディレクトリ。未指定時は `sources` のlocal型エントリを参照
- `filters`: ノイズフィルタ設定(未実装、スケルトン)

### `pipeline`

変換後処理パイプラインの設定(Phase 2以降で実装予定)。

```yaml
pipeline:
  on_error:
    post_extract: abort
    post_convert: skip
  post_extract:
  post_convert:
```

#### `on_error`

エラー時ポリシー。ステージごとのデフォルト挙動を指定する。

| 値      | 挙動                                                       |
| ------- | ---------------------------------------------------------- |
| `abort` | 中断。そのファイルの後続処理を止める                       |
| `skip`  | スキップ。ログ出力後、加工前の文字列を次のスクリプトへ渡す |

- 未指定のステージは `skip` がデフォルトとなる
- 各スクリプトに個別の `on_error` を指定すると、ステージデフォルトを上書きできる

#### `post_extract`

抽出後・Markdown変換前の処理(設定スキーマのみ定義。実行機構の実装は別タスク)。

#### `post_convert`

Markdown変換後に実行する後処理スクリプトの設定。上から順に直列実行する。

- 各スクリプトは `process(text, context)` 関数を動的ロードして実行する
- `only` 条件を指定すると該当ソース種別のみ実行する

CLI引数とconfig.yamlの対応関係
------------------------------

| CLI引数             | config.yaml のキー                   | 影響スクリプト                        |
| ------------------- | ------------------------------------ | ------------------------------------- |
| `--source-dir`      | `unknown_word_detection.source_dirs` | detect-unk.mjs                        |
| `--limit`           | (CLI専用)                            | detect-unk.mjs, update-embeddings.mjs |
| `--force`           | (CLI専用)                            | update-embeddings.mjs                 |
| `--vector`          | (CLI専用: 検索モード切替)            | search.mjs                            |
| `--hybrid`          | (CLI専用: 検索モード切替)            | search.mjs                            |
| `--top`             | `search.top_n_documents`             | search.mjs                            |
| `--detailed` / `-D` | (CLI専用: 出力形式切替)              | export-user-dict.mjs                  |
