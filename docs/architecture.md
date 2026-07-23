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

--- 未知語検出 後処理パイプライン ---

DuckDB (unknown_words / pos_master)
    │
    ▲ detect-unk.mjs              ← Lindera Tokenizer ← chapters.content
    │
    ├ export-unknown-words.mjs    → CSV（人間編集用）
    ├ import-unknown-words.mjs    ← CSV（編集済み）→ DB UPSERT
    ├ export-pos-master.mjs       → CSV（品詞マスタ編集用）
    ├ import-pos-master.mjs       ← CSV → DB UPSERT
    ├ export-user-dict.mjs        → CSV（Linderaビルド用）
    └ build-user-dict.mjs         → コンパイル済みユーザー辞書
```

技術スタック
-------------------------

| 役割               | 採用技術                                          |
|--------------------|---------------------------------------------------|
| 設定管理           | .knowledge-base.yml + lib/config.mjs (zx/js-yaml) |
| ベクトル化モデル   | intfloat/multilingual-e5-small (384次元)          |
| ベクトル化実行基盤 | @huggingface/transformers (Node.js)               |
| 形態素解析         | lindera-nodejs (NAPI-RS, IPADIC辞書)              |
| ユーザー辞書ビルド | Lindera CLI (`lindera build --user`)              |
| ベクトルDB         | DuckDB (FLOAT[384] + list_cosine_similarity)      |
| FTSエンジン        | DuckDB FTS拡張 (BM25)                             |
| PageRank           | graphology + graphology-pagerank                  |
| Markdownパース     | remark + remark-gfm (MDAST)                       |
| HTML変換           | rehype-parse + rehype-remark                      |
| PDF変換            | pdfjs-dist legacy build                           |
| Word変換           | mammoth.js                                        |
| スクリプト実行基盤 | zx (Node.js)                                      |

テーブル構成
-------------------------

テーブル定義の詳細は[schema.sql](schema.sql)を参照。

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

各係数は `.knowledge-base.yml` で外部調整可能。

擬似要約の生成
-------------------------

| 対象              | 内容                            | embedding入力          |
|-------------------|---------------------------------|------------------------|
| documents.summary | 見出しtree(h1〜h6を`#`表記で連結) | passage: {見出しtree}  |
| chapters.summary  | 見出し + 最初の段落             | passage: {見出し+段落} |

データフロー
-------------------------

### 取り込みパイプライン

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

### 未知語検出 後処理パイプライン

未知語検出は取り込みとは独立した後処理として実行する。

```
chapters.content
    │
    ▼
detect-unk.mjs               ← Lindera Tokenizer + UNK_FILTERS
    │
    ▼
unknown_words (DuckDB)
    │
    ├ export-unknown-words.mjs  →  unknown-words.csv (全カラム、ヘッダーあり)
    │                               ↓ 人間がExcel編集
    └ import-unknown-words.mjs  ←  unknown-words.csv (編集済み) → UPSERT
    │
    ├ export-pos-master.mjs     →  pos-master.csv
    │                               ↓ 人間が編集
    └ import-pos-master.mjs     ←  pos-master.csv → UPSERT
    │
    ├ export-user-dict.mjs      →  user-dict.csv (Simple/Detailed形式)
    └ build-user-dict.mjs       →  lindera build --user → ユーザー辞書
    │
    ▼
ingest.mjs (tokenizeWithLindera で --user-dict 参照)
```

プラグイン方式
-------------------------

ソース種別ごとに `fetch-*.mjs` を追加することで拡張可能。
各スクリプトは以下を守る

1. stdoutにYAMLフロントマター + Markdownを出力
2. ログはstderrに出力
3. 認証方式は内部で完結(ingest.mjsは認証を意識しない)
