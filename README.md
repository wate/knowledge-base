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

検索モードとスコアの決まり方は[docs/search.md](docs/search.md)を参照。

必要な外部ツール
-------------------------

| ツール  | バージョン | 用途                     | 確認コマンド        |
| ------- | ---------- | ------------------------ | ------------------- |
| Node.js | v24+       | スクリプト実行基盤       | `node --version`    |
| zx      | ^8.x       | スクリプト実行環境       | `npm install -g zx` |
| lindera | ^6.x       | ユーザー辞書ビルド(任意) | `lindera --version` |

zxはグローバルインストール必須。DuckDBは`@duckdb/node-api`が`npm install`時に同梱されます。
`lindera`はユーザー辞書ビルドにのみ必要で、未知語検出を使わない場合は不要です。

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

`source_mappings` セクションを使うと、Gitでクローンした公式ドキュメントのMarkdownと原本URLの対応関係を定義できる。
検索結果に原本URL(📎)が表示され、ワンクリックで公式サイトを確認できるようになる(詳細は `source_mappings` セクションを参照)。

#### 最低限の設定例

```yaml
sources:
  - docs                      # ローカルディレクトリ（再帰スキャン）
  - https://example.com/docs  # Webソース

# クローンしたドキュメントと原本URLの対応（省略可）
# source_mappings:
#   - match: "external/cakephp/**"
#     url_template: "https://book.cakephp.org/5/en/{{ path }}"
#     replace_ext:
#       .md: .html

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
zx path/to/knowledge-base.mjs search "検索ワード"
zx path/to/knowledge-base.mjs search --vector "検索ワード"
zx path/to/knowledge-base.mjs search --hybrid "検索ワード"
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
zx path/to/knowledge-base.mjs update-embeddings

# embedding全件再生成
zx path/to/knowledge-base.mjs update-embeddings --limit 0
```

個別コマンドリファレンス
-------------------------

すべて `knowledge-base.mjs` のサブコマンドとして実行します(`--help`で一覧を表示できます)。

| コマンド                                | 用途                                              |
| --------------------------------------- | ------------------------------------------------- |
| `knowledge-base.mjs sync [<src>]`       | 収集・取り込み・索引更新(差分更新)                |
| `knowledge-base.mjs update-embeddings`  | embedding生成(未処理のみ/`--limit 0`で全件再生成) |
| `knowledge-base.mjs update-pagerank [<dir>]` | PageRank更新                                      |
| `knowledge-base.mjs search <query>`     | BM25全文検索                                      |
| `knowledge-base.mjs search --vector <query>` | ベクトル検索                                      |
| `knowledge-base.mjs search --hybrid <query>` | ハイブリッド検索                                  |
| `knowledge-base.mjs dict <操作>`        | 辞書メンテナンス(未知語検出・CSV入出力)           |

### 注意

取り込みは `sync` に統合されています。単一ソースは `sync <src>`、変換結果の確認は `sync --dry-run` を使ってください。

エラーと終了コード
-------------------------

終了コードは3種類あり、使い方の誤りと処理の失敗を区別します。

| コード | 意味                           | 例                                   |
| ------ | ------------------------------ | ------------------------------------ |
| `0`    | 成功(該当なし・対象なしを含む) | 検索結果0件、embedding対象なし       |
| `1`    | 実行時エラー                   | ファイル未検出、DB操作失敗、抽出失敗 |
| `2`    | 使い方・設定エラー             | 引数不正、設定値のバリデーション違反 |

- `--help`は`0`で終わります
- 設定ファイルが見つからない場合は警告して継続し、設定が必須のコマンドのみエラーとします

### 出力先

- 機械可読な出力(検索結果・`--json`、CSV)は標準出力へ出します
- 進捗・警告・エラーは標準エラーへ出します
- 警告の破棄に`2>/dev/null`は不要です

### 警告と中断

- 一括系(`sync`)は1件の失敗で全体を止めず、警告を出して継続し、末尾に集計(成功・失敗・スキップ)を表示します
- 単体系(`search`など)は失敗した時点で中断し、終了コード`1`を返します
- 抽出に失敗したドキュメントは内容が空のまま登録せず、スキップして警告を出します
- `catch`して握りつぶす場合は必ず警告を出します

ディレクトリ構成
-------------------------

```
knowledge-base/
├ package.json            # 依存パッケージ管理
├ knowledge-base.mjs      # 唯一のエントリポイント(サブコマンド方式)
├ knowledge-base.duckdb   # DuckDBデータベース(取り込み・索引)
├ lib/
│ ├ collect.mjs       # 収集＋変換(単一ソース)
│ ├ ingest.mjs        # 取り込み(チャプター分割・FTS再構築)
│ ├ sync.mjs          # 取り込み経路の統合(差分更新・索引更新)
│ ├ search.mjs        # BM25/ベクトル/ハイブリッド検索
│ ├ update-embeddings.mjs  # embedding生成
│ ├ update-pagerank.mjs    # PageRank更新(リンク解析内蔵)
│ ├ update-dict.mjs   # 辞書の再取得・再ビルド
│ ├ db.mjs            # DB接続(トランザクション)
│ ├ lock.mjs          # 排他制御(O_EXCLロック)
│ ├ errors.mjs        # 共通エラー型
│ ├ dict/             # 辞書メンテナンス(未知語検出・CSV入出力)
│ ├ config.mjs        # 設定読み込み共通モジュール
│ ├ embed.mjs         # embedding共通モジュール
│ ├ lindera.mjs       # Linderaバインディング共通モジュール
│ ├ extract/          # 変換モジュール(anydoc/registry)
│ ├ normalize.mjs     # 取り込み時の正規化(MDASTのtextノード)
│ └ source/           # source plugin(registry/local/web)
├ docs/               # ドキュメント(schema.sql, config-reference.md等)
├ dict/               # Lindera辞書とメンテナンス用のCSV
│ ├ system/           # システム辞書(typeで指定した種別)
│ ├ user/             # ユーザー辞書(user-dict.bin)
│ └ *.csv            # 未知語・品詞マスタ・ユーザー辞書ビルド用
├ tests/              # 単体テスト(node:test)
└ tmp/
  └ models/           # embeddingモデルのキャッシュ
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
