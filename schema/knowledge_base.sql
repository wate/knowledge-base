-- ナレッジベース スキーマ定義
-- DuckDB v1.5.x 対応
--
-- DuckDB は AUTOINCREMENT をサポートしないため、
-- CREATE SEQUENCE + DEFAULT nextval() でオートインクリメントを実現する。
--
-- 使い方:
--   初回セットアップ: duckdb knowledge-base.duckdb < schema/knowledge_base.sql
--   FTSインデックスは ingest.mjs の取り込み完了後に自動生成される

INSTALL fts;
LOAD fts;

CREATE SEQUENCE IF NOT EXISTS documents_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS chapters_id_seq START 1;

-- documents: 取り込んだMarkdownファイル1件につき1行のドキュメント管理テーブル
CREATE TABLE IF NOT EXISTS documents (
    id              INTEGER PRIMARY KEY DEFAULT nextval('documents_id_seq'), -- ドキュメントの一意識別子
    file_path       VARCHAR UNIQUE, -- URI識別子。ローカルは相対パス、WebはURL、ツールは scheme://...
    content         TEXT,          -- YAMLフロントマター除去後のMarkdown全文
    summary         TEXT,          -- 見出しtree構造テキスト（h1〜h6をインデントで表現、embeddingの入力）
    embedding       FLOAT[384],    -- summary（見出しtree）をベクトル化した384次元ベクトル
    pagerank_score  FLOAT DEFAULT 1.0, -- doc_linksのリンク構造からPageRankアルゴリズムで算出した重要度スコア
    modified        TIMESTAMP      -- ファイルの最終更新日時（mtime）
);

-- chapters: ドキュメントを見出し階層で分割した「章」単位の管理テーブル
CREATE TABLE IF NOT EXISTS chapters (
    id              INTEGER PRIMARY KEY DEFAULT nextval('chapters_id_seq'), -- 章の一意識別子
    document_id     INTEGER,       -- 親ドキュメントのID（documents.id への外部参照）
    heading         VARCHAR,       -- 章の見出しテキスト（見出しがないファイルの場合はNULL）
    level           INTEGER,       -- 見出しレベル（1〜6、見出しがないファイルの場合はNULL）
    weight          FLOAT,         -- levelに応じた重み（h1=9.0 → h6=1.0、config.yamlで調整可能）
    chunk_index     INTEGER,       -- ドキュメント内での出現順（0始まり）
    content         TEXT,          -- 章本文（MDASTから再変換したMarkdown、見出し行自体は含まない）
    summary         TEXT,          -- 章の擬似要約（見出し＋最初の段落、embeddingの入力）
    content_wakati  TEXT,          -- content をLinderaで分かち書きした結果（FTS/BM25検索に使用）
    embedding       FLOAT[384]     -- summary（章の擬似要約）をベクトル化した384次元ベクトル
);

-- doc_links: ドキュメント間のMarkdownリンク関係を管理するテーブル（PageRank計算に使用）
CREATE TABLE IF NOT EXISTS doc_links (
    source_doc_id   INTEGER,       -- リンク元ドキュメントのID
    target_doc_id   INTEGER,       -- リンク先ドキュメントのID
    anchor_text     VARCHAR,       -- リンクテキスト（アンカーテキスト、md-linksからは空文字で投入）
    PRIMARY KEY (source_doc_id, target_doc_id) -- 同じリンクの重複登録を防止
);

-- sources: 外部ソースから取得したドキュメントの出典情報を管理するテーブル（鮮度管理に使用）
CREATE SEQUENCE IF NOT EXISTS sources_id_seq START 1;
CREATE TABLE IF NOT EXISTS sources (
    id              INTEGER PRIMARY KEY DEFAULT nextval('sources_id_seq'), -- レコードの一意識別子
    document_id     INTEGER REFERENCES documents(id), -- ドキュメントのID（外部キー制約）
    url             VARCHAR,       -- 取得元のURLまたはURI（file://, smb://等）
    source_type     VARCHAR,       -- ソース種別: 'web', 'project_tool', 'local_file', 'nas' 等
    fetched_at      TIMESTAMP,     -- 外部情報取得日
    UNIQUE(url, document_id)       -- 同じURLが同じドキュメントに重複登録されるのを防止
);
