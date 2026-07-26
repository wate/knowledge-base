Knowledge Base
=========================

ローカル完結のベクトル検索エンジン。Markdown・HTMLドキュメントをDuckDBに取り込み、BM25全文検索・ベクトル検索・ハイブリッド検索を提供する。

特徴
-------------------------

- ローカル完結: 全処理をローカル環境で実行。外部API不要
- 多言語ベクトル検索: intfloat/multilingual-e5-smallによる384次元ベクトル検索
- 日本語全文検索: Lindera形態素解析 + DuckDB FTS(BM25)
- PageRank: ドキュメント間リンク構造に基づく重要度スコアリング
- 設定駆動: `.knowledge-base.yml` の `sources` 定義に従い一括処理

必要な外部ツール
-------------------------

| ツール  | バージョン | 用途                 | インストール確認            |
| ------- | ---------- | -------------------- | --------------------------- |
| Node.js | v24+       | 全スクリプト実行基盤 | `node --version`            |
| zx      | ^8.x       | スクリプト実行環境   | `npm install -g zx`         |
| lindera | ^4.x       | ユーザー辞書ビルド   | `lindera --version`（任意） |

zxはグローバルインストール必須(`npm install -g zx`)。DuckDBエンジンは `@duckdb/node-api` が `npm install` 時に自動的に同梱するため、別途インストールは不要。`lindera` CLIはユーザー辞書ビルドにのみ必要で、未知語検出を使わない場合はインストール不要。全スクリプトは `zx` コマンドで実行する。

クイックスタート
-------------------------

### 1. 依存関係のインストール

```bash
cd <knowledge-base/ があるディレクトリ>
npm install
```

### 2. 設定ファイルを置く

ドキュメントを管理したいディレクトリ(プロジェクトルートなど)に `.knowledge-base.yml` を作成します。
設定の詳細は[docs/config-reference.md](docs/config-reference.md)を参照。

#### 最低限の設定例

```yaml
sources:
  - docs                      # ローカルディレクトリ（再帰スキャン）
  - https://example.com/docs  # Webソース

database:
  path: path/to/knowledge-base.duckdb
```

データベースファイルが存在しない場合は初回実行時に自動的に作成・初期化される。`database.path` に任意のパスを指定できる。

### 3. 取り込み＆検索可能にする

設定ファイルのあるディレクトリ(カレントディレクトリ)で以下を実行します。

```bash
zx path/to/knowledge-base.mjs
```

これだけで設定ファイルの全ソースを収集・取り込み・ベクトル化し、検索可能な状態になります。

### 4. 検索する

```bash
zx path/to/search.mjs "検索ワード"
zx path/to/search.mjs --vector "検索ワード"
zx path/to/search.mjs --hybrid "検索ワード"
```

便利なオプション
-------------------------

```bash
# ローカルファイルのみ処理（Webソースをスキップ）
zx path/to/knowledge-base.mjs --local-only

# 全件再取り込み（差分更新をスキップ）
zx path/to/knowledge-base.mjs --full

# 取り込みのみ（embedding生成は後でまとめて）
zx path/to/knowledge-base.mjs --skip-embed

# PageRank更新をスキップ
zx path/to/knowledge-base.mjs --skip-pagerank

# 各ソース先頭5件のみテスト
zx path/to/knowledge-base.mjs --limit 5

# 未処理のembeddingだけ生成
zx path/to/update-embeddings.mjs

# embedding全件再生成
zx path/to/update-embeddings.mjs --limit 0
```

個別コマンドリファレンス
-------------------------

`knowledge-base/` 内の各スクリプトは個別にも実行できます。

| コマンド                                  | 用途                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `ingest.mjs <file>...`                    | MarkdownファイルをDBに取り込む                    |
| `collect.mjs <src>` → `ingest.mjs - <id>` | Web/PDFなどを収集→取り込み                        |
| `update-embeddings.mjs`                   | embedding生成(未処理のみ/`--limit 0`で全件再生成) |
| `update-pagerank.mjs <dir>`               | PageRank更新                                      |
| `search.mjs <query>`                      | BM25全文検索                                      |
| `search.mjs --vector <query>`             | ベクトル検索                                      |
| `search.mjs --hybrid <query>`             | ハイブリッド検索                                  |

### 注意

`collect.mjs` は単一ソース専用です。ディレクトリの一括処理は `knowledge-base.mjs` を使ってください。

ディレクトリ構成
-------------------------

```
knowledge-base/
├ package.json            # 依存パッケージ管理
├ knowledge-base.mjs      # 統合エントリポイント（設定ファイルベース一括処理）
├ collect.mjs             # 収集＋変換（単一ソース専用）
├ ingest.mjs              # 取り込みパイプライン
├ search.mjs              # BM25/ベクトル/ハイブリッド検索
├ update-embeddings.mjs   # embedding生成（--force対応）
├ update-pagerank.mjs     # PageRank更新(リンク解析内蔵)
├ detect-unk.mjs          # Linderaで未知語(UNK)抽出
├ export-unknown-words.mjs  # unknown_wordsテーブルCSV出力
├ import-unknown-words.mjs  # 編集済みCSVをunknown_wordsに取り込み
├ export-pos-master.mjs     # pos_masterテーブルCSV出力
├ import-pos-master.mjs     # 編集済みCSVをpos_masterに取り込み
├ export-user-dict.mjs      # ユーザー辞書ビルド用CSV出力
├ lib/
│ ├ config.mjs        # 設定読み込み共通モジュール
│ ├ embed.mjs         # embedding共通モジュール
│ ├ lindera.mjs       # Linderaバインディング共通モジュール
│ ├ convert/          # 変換スクリプト(pdf/docx/html)
│ ├ extract/          # 抽出モジュール(registry/pdf)
│ ├ pipeline/         # 後処理パイプライン(pipeline/normalize-text)
│ └ source/           # source plugin(registry/local/web)
├ docs/               # ドキュメント(schema.sql, config-reference.md等)
└ dict/               # Lindera辞書
```

DBテーブル
-------------------------

| テーブル        | 説明                                                   |
| --------------- | ------------------------------------------------------ |
| `documents`     | ドキュメント全体(全文・見出しtree・ベクトル・PageRank) |
| `chapters`      | 章単位(本文・擬似要約・分かち書き・ベクトル)           |
| `doc_links`     | ドキュメント間リンク(PageRank計算用)                   |
| `sources`       | 外部ソース出典情報(URL・取得日・種別)                  |
| `pos_master`    | 品詞マスタ(未知語レビュー時の選択肢)                   |
| `unknown_words` | 未知語管理(レビュー・ユーザー辞書出力の基盤)           |

ライセンス
-------------------------

Apache License 2.0
