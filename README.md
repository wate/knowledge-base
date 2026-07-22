KnowlEdge Base
=========================

ローカル完結のベクトル検索エンジン。Markdown・HTMLドキュメントをDuckDBに取り込み、BM25全文検索・ベクトル検索・ハイブリッド検索を提供する。

特徴
-------------------------

- ローカル完結: 全処理をローカル環境で実行。外部API不要
- 多言語ベクトル検索: intfloat/multilingual-e5-smallによる384次元ベクトル検索
- 日本語全文検索: Lindera形態素解析 + DuckDB FTS(BM25)
- **PageRank**: ドキュメント間リンク構造に基づく重要度スコアリング
- プラグイン方式: `fetch-*.mjs` でソース種別ごとに拡張可能

必要な外部ツール
-------------------------

| ツール      | バージョン | 用途                         | インストール確認    |
| ----------- | ---------- | ---------------------------- | ------------------- |
| DuckDB      | v1.5+      | ベクトルDB/FTS               | `duckdb --version`  |
| Lindera CLI | latest     | 日本語形態素解析(分かち書き) | `lindera --version` |
| Node.js     | v24+       | 全スクリプト実行基盤         | `node --version`    |
| zx          | ^8.x       | スクリプト実行環境           | `npm install -g zx` |

DuckDBは[DuckDBのサイト](https://duckdb.org)から、Lindera CLIのインストールは[GitHub](https://github.com/lindera/lindera)を参照。
zxはグローバルインストール必須(`npm install -g zx`)。全スクリプトは `zx` コマンドで実行する。

クイックスタート
-------------------------

### 依存関係のインストール

```bash
cd knowledge-base
npm install
```

### スキーマ作成

```bash
duckdb knowledge-base.duckdb < schema/knowledge_base.sql
```

### ドキュメントの取り込み

```bash
# Markdownファイル
zx ingest.mjs docs/index.md

# Webページ（HTML→Markdown変換→取り込み）
zx fetch-web.mjs https://example.com/page.html | zx ingest.mjs - <doc_id>

# ローカルファイル（自動判別）
zx fetch-local.mjs document.pdf | zx ingest.mjs - <doc_id>
```

### embedding生成

```bash
# 未処理レコードのみ
zx update-embeddings.mjs

# 全件再生成
zx update-embeddings.mjs --force
```

### PageRank更新

```bash
zx update-pagerank.mjs <target_dir>
```

### 検索

```bash
# BM25全文検索
zx search.mjs "検索クエリ"

# ベクトル検索
zx search.mjs --vector "検索クエリ"

# ハイブリッド検索
zx search.mjs --hybrid "検索クエリ"
```

ディレクトリ構成
-------------------------

```
knowledge-base/
├ package.json            # 依存パッケージ管理
├ config.yaml             # 検索スコア係数設定
├ schema/
│ └ knowledge_base.sql    # DDL（documents/chapters/doc_links/sources）
├ ingest.mjs              # 取り込みパイプライン
├ search.mjs              # BM25/ベクトル/ハイブリッド検索
├ update-embeddings.mjs   # embedding生成（--force対応）
├ update-pagerank.mjs     # PageRank更新
├ embed-lib.mjs           # embedding共通モジュール
├ convert-html.mjs        # HTML→Markdown変換
├ convert-pdf.mjs         # PDF→テキスト変換
├ convert-docx.mjs        # Word→Markdown変換
├ convert-lib.mjs         # 変換共通（正規化）
├ fetch-web.mjs           # Web取得→変換→フロントマター付与
├ fetch-local.mjs         # ローカルファイル変換→フロントマター付与
├ extract-urls.mjs        # MarkdownからURL抽出
├ knowledge-base.duckdb   # DuckDBデータベースファイル
└ docs/                   # 設計ドキュメント
```

対応ファイル形式
-------------------------

| 形式          | 変換方式                     | 優先度   |
| ------------- | ---------------------------- | -------- |
| Markdown(.md) | remark MDASTパース           | 完了     |
| HTML(.html)   | rehype-parse + rehype-remark | 完了     |
| PDF           | pdfjs-dist legacy            | 将来検討 |
| Word(.docx)   | mammoth.js                   | 将来検討 |

DBテーブル
-------------------------

| テーブル    | 説明                                                   |
| ----------- | ------------------------------------------------------ |
| `documents` | ドキュメント全体(全文・見出しtree・ベクトル・PageRank) |
| `chapters`  | 章単位(本文・擬似要約・分かち書き・ベクトル)           |
| `doc_links` | ドキュメント間リンク(PageRank計算用)                   |
| `sources`   | 外部ソース出典情報(URL・取得日・種別)                  |

ライセンス
-------------------------

Apache License 2.0
