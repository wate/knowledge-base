アーキテクチャ設計書
=========================

システム構成
-------------------------

```
external sources (Markdown / HTML / PDF / Word)
    │
    ▼
fetch-*.mjs / convert-*.mjs   ← 変換（+ YAMLフロントマター付与）
    │
    ▼ (stdout: Markdown)
ingest.mjs                     ← remark MDASTパース → チャンク分割 → DuckDB登録
    │
    ▼
DuckDB (documents / chapters / doc_links / sources)
    │
    ├ update-embeddings.mjs  ← intfloat/multilingual-e5-small ベクトル化
    └ update-pagerank.mjs    ← md-links → graphology PageRank
    │
    ▼
search.mjs                     ← BM25 / ベクトル / ハイブリッド検索
```

技術スタック
-------------------------

| 役割               | 採用技術                                     |
|--------------------|----------------------------------------------|
| ベクトル化モデル   | intfloat/multilingual-e5-small (384次元)     |
| ベクトル化実行基盤 | @huggingface/transformers (Node.js)          |
| 形態素解析         | Lindera CLI (IPADIC辞書)                     |
| ベクトルDB         | DuckDB (FLOAT[384] + list_cosine_similarity) |
| FTSエンジン        | DuckDB FTS拡張 (BM25)                        |
| PageRank           | graphology + graphology-pagerank             |
| Markdownパース     | remark + remark-gfm (MDAST)                  |
| HTML変換           | rehype-parse + rehype-remark                 |
| PDF変換            | pdfjs-dist legacy build                      |
| Word変換           | mammoth.js                                   |
| スクリプト実行基盤 | zx (Node.js)                                 |

テーブル構成
-------------------------

### documents

ドキュメント全体の管理。`file_path` はURI形式で一意に識別する。

| カラム         | 型             | 説明                                   |
|----------------|----------------|----------------------------------------|
| id             | INTEGER PK     | 自動採番                               |
| file_path      | VARCHAR UNIQUE | URI識別子(相対パス/URL/Redmine://等)   |
| content        | VARCHAR        | YAMLフロントマター除去後のMarkdown全文 |
| summary        | VARCHAR        | 見出しtree構造テキスト(embedding入力)  |
| embedding      | FLOAT[384]     | summaryのベクトル                      |
| pagerank_score | FLOAT          | PageRankスコア(デフォルト1.0)          |
| modified       | TIMESTAMP      | 最終更新日時                           |

### chapters

ドキュメントを見出し階層で分割した章単位。

| カラム         | 型         | 説明                         |
|----------------|------------|------------------------------|
| id             | INTEGER PK | 自動採番                     |
| document_id    | INTEGER    | 親ドキュメントID             |
| heading        | VARCHAR    | 見出しテキスト               |
| level          | INTEGER    | 見出しレベル(1〜6)           |
| weight         | FLOAT      | レベルに応じた重み           |
| chunk_index    | INTEGER    | 出現順(0始まり)              |
| content        | VARCHAR    | 章本文                       |
| summary        | VARCHAR    | 擬似要約(見出し+最初の段落)  |
| content_wakati | VARCHAR    | Lindera分かち書き結果(FTS用) |
| embedding      | FLOAT[384] | summaryのベクトル            |

### sources

外部ソースの出典情報(鮮度管理用)。

| カラム                   | 型         | 説明                          |
|--------------------------|------------|-------------------------------|
| id                       | INTEGER PK | 自動採番                      |
| document_id              | INTEGER FK | ドキュメントID                |
| url                      | VARCHAR    | 取得元URL                     |
| source_type              | VARCHAR    | web / local_file / Redmine 等 |
| fetched_at               | TIMESTAMP  | 取得日                        |
| UNIQUE(url, document_id) |            | 重複防止                      |

検索スコア設計
-------------------------

### ベクトル検索

```
最終スコア = cosine_similarity × 0.5
           + PageRank(正規化) × 0.2
           + heading_weight(正規化) × 0.2
           + position_norm × 0.1
```

### ハイブリッド検索

```
最終スコア = ベクトルスコア(上記合算) × 0.7
           + BM25スコア(正規化) × 0.3
```

各係数は `config.yaml` で外部調整可能。

擬似要約の生成
-------------------------

| 対象              | 内容                            | embedding入力          |
|-------------------|---------------------------------|------------------------|
| documents.summary | 見出しtree(h1〜h6を`#`表記で連結) | passage: {見出しtree}  |
| chapters.summary  | 見出し + 最初の段落             | passage: {見出し+段落} |

データフロー
-------------------------

```
fetch-web.mjs <URL>          fetch-local.mjs <file>
    │                              │
    │ (HTML→Markdown + YAML)       │ (拡張子自動判別 + YAML)
    │                              │
    └──────────┬───────────────────┘
               ▼ (stdout: フロントマター付きMarkdown)
          ingest.mjs
               │
               ├ YAMLフロントマター → sourcesテーブル
               ├ remark MDAST → チャンク分割 → chapters
               ├ Lindera分かち書き → content_wakati
               └ PRAGMA create_fts_index (FTS自動生成)
               │
               ▼
          update-embeddings.mjs (バッチ書き込み、--force対応)
               │
               ▼
          update-pagerank.mjs (md-links → doc_links → PageRank)
```

プラグイン方式
-------------------------

ソース種別ごとに `fetch-*.mjs` を追加することで拡張可能。
各スクリプトは以下を守る

1. stdoutにYAMLフロントマター + Markdownを出力
2. ログはstderrに出力
3. 認証方式は内部で完結(ingest.mjsは認証を意識しない)
