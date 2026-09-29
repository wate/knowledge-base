アーキテクチャ設計書
=========================

システム構成
-------------------------

````
external sources (Markdown / HTML / PDF / ...)
    │
    ▼  ① データ収集
lib/collect                           (source plugin: local/web/...)
    │
    ▼  ② Markdown化 (lib/extract/)
extract (anydoc / rehype / 素通し)    バイナリ・HTML→Markdown
    │
    ▼  ③ YAMLフロントマター付与
stdout (フロントマター付きMarkdown)
    │
    ▼
lib/ingest                            チャンク分割→DuckDB登録
```                     ← remark MDASTパース → チャンク分割 → DuckDB登録
    │
    ▼
DuckDB (documents / chapters / doc_links / sources)
    │
    ├ lib/update-embeddings  ← intfloat/multilingual-e5-small ベクトル化
    └ lib/update-pagerank    ← 内部リンク抽出 → graphology PageRank
    │
    ▼
lib/search                     ← BM25 / ベクトル / ハイブリッド検索

--- 未知語検出 後処理パイプライン ---

DuckDB (unknown_words / pos_master)
    │
    ▲ detect                      ← Lindera Tokenizer ← chapters.content
    │
    ├ export-unknown-words        → CSV（人間編集用）
    ├ import-unknown-words        ← CSV（編集済み）→ DB UPSERT
    ├ export-pos-master          → CSV（品詞マスタ編集用）
    ├ import-pos-master          ← CSV → DB UPSERT
    ├ export-user-dict             → CSV（Linderaビルド用）
    └ build-user-dict             → コンパイル済みユーザー辞書
````

実行の入口は単一の`knowledge-base.mjs`で、サブコマンド(`sync`・`search`・`update-embeddings`・`update-pagerank`・`dict <操作>`)として呼び出す。
図中の`lib/`はモジュール名、dict系の操作名(`detect`・`export-unknown-words`など)は`dict`サブコマンドの操作を示す。

技術スタック
-------------------------

| 役割               | 採用技術                                                          |
| ------------------ | ----------------------------------------------------------------- |
| 設定管理           | .knowledge-base.yml + lib/config.mjs (zx/js-yaml)                 |
| ベクトル化モデル   | intfloat/multilingual-e5-small (384次元)                          |
| ベクトル化実行基盤 | @huggingface/transformers (Node.js)                               |
| 形態素解析         | lindera (NAPI-RS, ipadic辞書)                                     |
| ユーザー辞書ビルド | Lindera CLI (`lindera build --user`)                              |
| ベクトルDB         | DuckDB (FLOAT[384] + list_cosine_similarity) via @duckdb/node-api |
| FTSエンジン        | DuckDB FTS拡張 (BM25) via @duckdb/node-api                        |
| PageRank           | graphology + graphology-pagerank                                  |
| Markdownパース     | remark + remark-gfm (MDAST)                                       |
| HTML変換           | rehype-parse + rehype-remark                                      |
| 文書変換           | @firecrawl/anydoc (PDF・Office・EPUB等の19拡張子)                 |
| スクリプト実行基盤 | zx (Node.js)                                                      |

テーブル構成
-------------------------

テーブル定義の詳細は[schema.sql](schema.sql)を参照。

### 外部キー制約に関する注意

`sources`テーブルの`document_id`カラムは`documents.id`を参照する設計だが、**FK制約は設定していない**。

理由は、「Over-Eager Constraint Checking in Foreign Keys」というDuckDBの既知の制限である。
`FLOAT[384]`型カラムの`UPDATE`が内部で`DELETE+INSERT`に書き換えられた際に、FK違反が発生する。
この制限は`documents.embedding`(`FLOAT[384]`)の更新を阻害するため、`sources`テーブルからFK制約を除去した。
代わりに`idx_sources_document_id`インデックスでJOIN性能を確保している。

この制限はDuckDB v1.5.5でも再現する(`documents.embedding`の`UPDATE`が`Violates foreign key constraint`で失敗することを実測で確認)。
一方、FK制約の検査自体は機能しており、参照先の存在しない行の`INSERT`は拒否される。

参照整合性はアプリケーションレベル(`lib/db.mjs`のトランザクションによる`BEGIN/COMMIT/ROLLBACK`)で担保する。

検索スコア設計
-------------------------

順位が決まる仕組みと各係数の意味は[検索方式](search.md)を参照。

### ベクトル検索

```
最終スコア = cosine類似度(min-max正規化) × 0.65
           + PageRank(min-max正規化) × 0.05
           + heading_weight(正規化) × 0.2
           + position_norm × 0.1
```

### ハイブリッド検索

```
最終スコア = ベクトルスコア(上記合算) × 0.7
           + BM25スコア(生の値) × 0.3
```

各係数は `.knowledge-base.yml` で外部調整可能。

擬似要約の生成
-------------------------

| 対象              | 内容                              | embedding入力          |
| ----------------- | --------------------------------- | ---------------------- |
| documents.summary | 見出しtree(h1〜h6を`#`表記で連結) | passage: {見出しtree}  |
| chapters.summary  | 見出し + 最初の段落               | passage: {見出し+段落} |

データフロー
-------------------------

図中のラベルは`lib/`配下のモジュール名、および`dict`サブコマンドの操作名を示す。

### 取り込みパイプライン

```
lib/collect (<file> / <URL> / <dir> / --source <type>)
    │
    ├ ① source検出 → plugin.collect() (local / web / ...)
    ├ ② Markdown化: バイナリはanydoc、HTMLはrehype、Markdownは素通し
    └ ③ YAMLフロントマター付与
    │
    ▼ (stdout: フロントマター付きMarkdown)
lib/ingest
               │
               ├ YAMLフロントマター → sourcesテーブル
               ├ remark MDAST → textノードの正規化 → チャンク分割 → chapters
               ├ Lindera分かち書き → content_wakati
               └ PRAGMA create_fts_index (FTS自動生成)
               │
               ▼
          lib/update-embeddings (バッチ書き込み、--force対応)
               │
               ▼
          lib/update-pagerank (内部リンク抽出 → doc_links → PageRank)
```

### 未知語検出 後処理パイプライン

未知語検出は取り込みとは独立した後処理として実行する。

```
chapters.content
    │
    ▼
detect                       ← Lindera Tokenizer + UNK_FILTERS
    │
    ▼
unknown_words (DuckDB)
    │
    ├ export-unknown-words      →  unknown-words.csv (全カラム、ヘッダーあり)
    │                               ↓ 人間がExcel編集
    └ import-unknown-words      ←  unknown-words.csv (編集済み) → UPSERT
    │
    ├ export-pos-master        →  pos-master.csv
    │                               ↓ 人間が編集
    └ import-pos-master        ←  pos-master.csv → UPSERT
    │
    ├ export-user-dict           →  user-dict.csv (Simple/Detailed形式)
    └ build-user-dict           →  lindera build --user → ユーザー辞書
    │
    ▼
lib/ingest (tokenizeWithLindera で --user-dict 参照)
```

プラグイン方式
-------------------------

ソース種別ごとに `lib/source/` 以下にpluginを追加することで拡張可能。
各pluginは以下を守る。

1. `export async function collect(sourceSpec, options)` を公開する
2. 戻り値は `{ content, title, sourceType, sourceMeta, rawFilePath? }` 形式
3. `lib/collect.mjs`は収集結果を既存パイプライン(extract→convert→frontmatter)に委譲する
4. 認証方式はplugin内部で完結する(`lib/collect.mjs`は認証を意識しない)
