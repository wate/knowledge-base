Knowledge Base
=========================

ローカル完結のベクトル検索エンジン。Markdown・HTMLドキュメントをDuckDBに取り込み、BM25全文検索・ベクトル検索・ハイブリッド検索を提供する。

特徴
-------------------------

- ローカル完結: 全処理をローカル環境で実行。外部API不要
- 多言語ベクトル検索: intfloat/multilingual-e5-smallによる384次元ベクトル検索
- 日本語全文検索: Lindera形態素解析 + DuckDB FTS(BM25)
- PageRank: ドキュメント間リンク構造に基づく重要度スコアリング
- プラグイン方式: `fetch-*.mjs` でソース種別ごとに拡張可能

必要な外部ツール
-------------------------

| ツール      | バージョン | 用途                                         | インストール確認  |
|-------------|------------|----------------------------------------------|-------------------|
| DuckDB      | v1.5+      | ベクトルDB/FTS                               | `duckdb --version` |
| Lindera CLI | latest     | ユーザー辞書コンパイル(`lindera build --user`) | `lindera --version` |
| Node.js     | v24+       | 全スクリプト実行基盤                         | `node --version`  |
| zx          | ^8.x       | スクリプト実行環境                           | `npm install -g zx` |

DuckDBは[DuckDBのサイト](https://duckdb.org)から、Lindera CLIのインストールは[GitHub](https://github.com/lindera/lindera)を参照。
zxはグローバルインストール必須(`npm install -g zx`)。全スクリプトは `zx` コマンドで実行する。

クイックスタート
-------------------------

**注**: 現時点ではプロトタイプ開発段階のため、スクリプトの一般公開は検討中です。

### 依存関係のインストール

```bash
cd knowledge-base
npm install
```

### スキーマ作成

```bash
duckdb knowledge-base.duckdb < docs/schema.sql
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

### 未知語検出とユーザー辞書

Linderaの未知語(UNK)を検出し、レビュー後にユーザー辞書として活用する一連のフロー。

```
detect-unk.mjs  →  unknown_words(DB)
                     ↓
                export-unknown-words.mjs  →  CSV(人間編集)
                     ↓
                import-unknown-words.mjs  ←  CSV→DB反映
                     ↓
                export-user-dict.mjs      →  CSV(Linderaビルド用)
                     ↓
                build-user-dict.mjs       →  ユーザー辞書
```

### UNK抽出

```bash
# 全ドキュメントから未知語を抽出
npm run detect-unk

# 先頭10件のみテスト
npm run detect-unk -- --limit 10
```

### レビュー用CSV入出力

```bash
# unknown_words → CSV（Excel編集用）
npm run export-unknown-words

# 編集済みCSV → DBに一括反映（wordをキーにUPSERT）
npm run import-unknown-words
npm run import-unknown-words -- path/to/edited.csv
```

### 品詞マスタメンテナンス

```bash
# pos_master → CSV
npm run export-pos-master

# 編集済みCSV → DB反映（idありUPSERT、idなし新規INSERT）
npm run import-pos-master
```

検索
-------------------------

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
├ config.yaml             # ナレッジベース全体設定
├ ingest.mjs              # 取り込みパイプライン
├ search.mjs              # BM25/ベクトル/ハイブリッド検索
├ update-embeddings.mjs   # embedding生成（--force対応）
├ update-pagerank.mjs     # PageRank更新
├ convert-html.mjs        # HTML→Markdown変換
├ convert-pdf.mjs         # PDF→テキスト変換
├ convert-docx.mjs        # Word→Markdown変換
├ fetch-web.mjs           # Web取得→変換→フロントマター付与
├ fetch-local.mjs         # ローカルファイル変換→フロントマター付与
├ extract-urls.mjs        # MarkdownからURL抽出
├ detect-unk.mjs          # Linderaで未知語(UNK)抽出
├ export-unknown-words.mjs # unknown_wordsテーブルCSV出力
├ import-unknown-words.mjs # 編集済みCSVをunknown_wordsに取り込み
├ export-pos-master.mjs    # pos_masterテーブルCSV出力
├ import-pos-master.mjs    # 編集済みCSVをpos_masterに取り込み
├ lib/
│ ├ config.mjs        # 設定読み込み共通モジュール
│ ├ embed.mjs         # embedding共通モジュール
│ ├ convert.mjs       # 変換共通（正規化）
│ └ lindera.mjs       # Linderaバインディング共通モジュール
├ knowledge-base.duckdb   # DuckDBデータベースファイル
├ docs/
│ ├ schema.sql            # DDL（全テーブル）
│ ├ config-reference.md   # 設定リファレンス
│ └ ...                   # 設計ドキュメント
└ dict/                   # Lindera辞書
```

対応ファイル形式
-------------------------

| 形式          | 変換方式                     | 優先度   |
|---------------|------------------------------|----------|
| Markdown(.md) | remark MDASTパース           | 完了     |
| HTML(.html)   | rehype-parse + rehype-remark | 完了     |
| PDF           | pdfjs-dist legacy            | 将来検討 |
| Word(.docx)   | mammoth.js                   | 将来検討 |

DBテーブル
-------------------------

| テーブル      | 説明                                                   |
|---------------|--------------------------------------------------------|
| `documents`   | ドキュメント全体(全文・見出しtree・ベクトル・PageRank) |
| `chapters`    | 章単位(本文・擬似要約・分かち書き・ベクトル)           |
| `doc_links`   | ドキュメント間リンク(PageRank計算用)                   |
| `sources`     | 外部ソース出典情報(URL・取得日・種別)                  |
| `pos_master`  | 品詞マスタ(未知語レビュー時の選択肢)                   |
| `unknown_words` | 未知語管理(レビュー・ユーザー辞書出力の基盤)           |

今後の検討材料
-------------------------

- PDF対応: `pdfjs-dist` によるテキスト抽出の本格実装
- Word(.docx)対応: `mammoth.js` による変換処理の本格実装
- Excel(.xlsx)対応: 表データの取り込み
- 設定ファイル対応(ノイズフィルタ外部化: Phase 2)
- 変換後処理パイプライン(Phase 3)
- Webインターフェース/API: ブラウザ上での管理UIやAPIエンドポイントによる外部連携

ライセンス
-------------------------

Apache License 2.0
