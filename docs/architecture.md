アーキテクチャ設計書
=========================

システム構成
-------------------------

````
external sources (Markdown / HTML / PDF / ...)
    │
    ▼  ① データ収集
collect.mjs                           (source plugin: local/web/...)
    │
    ▼  ② テキスト抽出 (lib/extract/)
extract (pdfjs / 素通し)              バイナリ→プレーンテキスト
    │
    ▼  ③ 抽出後処理 (lib/pipeline/)
[post_extract]                        後処理スクリプト直列実行
    │
    ▼  ④ Markdown変換
convert (unified / 手動構造化)        テキスト→Markdown
    │
    ▼  ⑤ 変換後処理 (lib/pipeline/)
[post_convert]                        後処理スクリプト直列実行
    │
    ▼  ⑥ YAMLフロントマター付与
stdout (フロントマター付きMarkdown)
    │
    ▼
ingest.mjs                            チャンク分割→DuckDB登録
```                     ← remark MDASTパース → チャンク分割 → DuckDB登録
    │
    ▼
DuckDB (documents / chapters / doc_links / sources)
    │
    ├ update-embeddings.mjs  ← intfloat/multilingual-e5-small ベクトル化
    └ update-pagerank.mjs    ← 内部リンク抽出 → graphology PageRank
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
````

技術スタック
-------------------------

| 役割               | 採用技術                                          |
| ------------------ | ------------------------------------------------- |
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

| 対象              | 内容                              | embedding入力          |
| ----------------- | --------------------------------- | ---------------------- |
| documents.summary | 見出しtree(h1〜h6を`#`表記で連結) | passage: {見出しtree}  |
| chapters.summary  | 見出し + 最初の段落               | passage: {見出し+段落} |

データフロー
-------------------------

### 取り込みパイプライン

```
collect.mjs (<file> / <URL> / <dir> / --source <type>)
    │
    ├ ① source検出 → plugin.collect() (local / web / ...)
    ├ ② extract: バイナリ→プレーンテキスト(pdfjs。md/html/txtは素通し)
    ├ ③ [post_extract]: 抽出後処理パイプライン
    ├ ④ convert: テキスト→Markdown(unified / 手動構造化 / 素通し)
    ├ ⑤ [post_convert]: 変換後処理パイプライン
    └ ⑥ YAMLフロントマター付与
    │
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
          update-pagerank.mjs (内部リンク抽出 → doc_links → PageRank)
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

ソース種別ごとに `lib/source/` 以下にpluginを追加することで拡張可能。
各pluginは以下を守る。

1. `export async function collect(sourceSpec, options)` を公開する
2. 戻り値は `{ content, title, sourceType, sourceMeta, rawFilePath? }` 形式
3. collect.mjsは収集結果を既存パイプライン(extract→convert→frontmatter)に委譲する
4. 認証方式はplugin内部で完結する(collect.mjsは認証を意識しない)
