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
| `KNOWLEDGE_BASE_TOP_N`           | `search.top_n_documents` | `20`                                     |

### パス解決

`.knowledge-base.yml` 内の相対パスは**ワーキングディレクトリ(プロセスカレント)**基準で絶対パスに解決する。
npm scriptsを `knowledge-base/` から実行する場合はパスの先頭に `knowledge-base/` を付けず、カレントディレクトリからの相対パスで記述する。

設定セクション一覧
-------------------------

### `sources`

データ取得元の一覧。`sync`がこの設定を読み取り、全ソースを統一的に処理する。

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

- `http://`/`https://` 始まり -> `type: web`(HTTP取得)
- それ以外 -> `type: local`(ファイルパスまたはディレクトリ)

#### 詳細形式のフィールド

- `source`: 実際の取得先(URL orファイルパス)
- `type`: source plugin名(local/web/Redmine/github...)
- `auth`: typeごとの認証情報
- `excludes`: local typeのみ、個別の除外ディレクトリ名(グローバルの `source_local.exclude_patterns` を上書き)
- `exclude_patterns`: local typeのみ、個別の除外globパターン
    - `excludes` がディレクトリ名単位なのに対し、こちらはファイル単位のパターン指定が可能
    - グローバルの `source_local.exclude_patterns` とマージして評価される

#### ソース単位の除外例

```yaml
sources:
  - docs
  - path: knowledge-base/external/cakephp
    exclude_patterns:
      - "**/404.md"
      - "**/contents.md"
```

上記の例では `knowledge-base/external/cakephp/` 配下から `404.md` と `contents.md` が除外される。

### `source_mappings`

ローカルファイルと原本URLの対応関係を定義する。
Gitでクローンした公式ドキュメントのMarkdownを解析元に使いながら、
検索結果から原本の公式サイトURLを参照できるようになる。

```yaml
source_mappings:
  - match: "knowledge-base/external/cakephp/**"
    url_template: "https://book.cakephp.org/5/en/{{ path }}"
    replace_ext:
      .md: .html
```

#### フィールド

- `match`: プロジェクトルートからの相対パスのglobパターン。これにマッチしたローカルファイルがマッピング対象となる
- `url_template`: `{{ path }}` に `match` 以降の相対パスが展開される
- `replace_ext`(省略可): 拡張子の置換ルール。キー->値のマップで指定

#### 変換例

| ローカルファイル                                      | 生成URL                                               |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `knowledge-base/external/cakephp/controllers.md`      | `https://book.cakephp.org/5/en/controllers.html`      |
| `knowledge-base/external/cakephp/orm/associations.md` | `https://book.cakephp.org/5/en/orm/associations.html` |

`source_mappings` が空(未設定)の場合は従来通り動作し、マッピングは行われない。
登録されたURLは `sources` テーブルに `source_type = 'ref'` として保存され、
`search` の検索結果に `📎` 付きで表示される。

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

- `path`: DBファイルのパス(ワーキングディレクトリからの相対パス、または絶対パス)。`@duckdb/node-api` に渡すDuckDBデータベースファイルを指定する。ファイルが存在しない場合は初回接続時に自動的に作成される。

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
ダウンロードするアーカイブは`type`から決定される(例: `ipadic-neologd` -> `lindera-ipadic-neologd-<version>.zip`)。

#### 辞書種別を変更する手順

1. `dictionary.type` を変更する
2. `knowledge-base.mjs update-dict` を実行する。`metadata.json` の `name` が設定と一致しないため、システム辞書が自動で再取得され、ユーザー辞書も再ビルドされる
3. `knowledge-base.mjs sync --full` を実行する。分かち書き(`chapters.content_wakati`)は旧辞書のまま残るため、全件を再取り込みする

`name` が一致していても再取得したい場合(Lindera本体の更新など)は、`update-dict --force` を使う。

### `ingest`

ドキュメント取り込みパイプラインの設定。

```yaml
ingest:
  min_heading_level: 3
```

- `min_heading_level`: チャプター分割に使う最も深い見出しレベル(h4以降は親章へ含める)

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

### `search`

検索スコア計算の設定。

```yaml
search:
  top_n_documents: 20
  weights:
    cosine: 0.65
    pagerank: 0.05
    heading: 0.2
    position: 0.1
  hybrid_weights:
    vector: 0.7
    bm25: 0.3
```

- `top_n_documents`: 2段階検索の第1段階で絞り込む文書数(`--top`の最終件数とは独立)
- `weights`: ベクトル検索スコアの内訳(合計が1.0になるように設定)
    - `cosine`: コサイン類似度(min-max正規化後)の重み
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

CLI引数と設定キーの対応関係
---------------------------

| CLI引数             | .knowledge-base.yml のキー           | 影響サブコマンド                   |
| ------------------- | ------------------------------------ | ---------------------------------- |
| `--source-dir`      | `unknown_word_detection.source_dirs` | `dict detect`                      |
| `--limit`           | (CLI専用)                            | `dict detect`, `update-embeddings` |
| `--force`           | (CLI専用)                            | `update-embeddings`                |
| `--vector`          | (CLI専用: 検索モード切替)            | `search`                           |
| `--hybrid`          | (CLI専用: 検索モード切替)            | `search`                           |
| `--top`             | (CLI専用: 最終件数)                  | `search`                           |
| `--detailed` / `-D` | (CLI専用: 出力形式切替)              | `dict export-user-dict`            |
