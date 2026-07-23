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
CREATE SEQUENCE IF NOT EXISTS sources_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS pos_master_id_seq START 1;

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
    fetched         TIMESTAMP,     -- 外部情報取得日
    UNIQUE(url, document_id)       -- 同じURLが同じドキュメントに重複登録されるのを防止
);

-- pos_master: 品詞マスタ（未知語レビュー時のプルダウン選択肢として使用）
CREATE TABLE IF NOT EXISTS pos_master (
    id    INTEGER PRIMARY KEY DEFAULT nextval('pos_master_id_seq'), -- 品詞ID（自動採番）
    name  VARCHAR NOT NULL,    -- 品詞名（例: 'カスタム名詞'）
    note  VARCHAR              -- 補足（任意）
);

INSERT INTO pos_master (name) VALUES
    ('カスタム名詞'),
    ('固有名詞'),
    ('一般名詞')
ON CONFLICT DO NOTHING;

-- unknown_words: 未知語管理テーブル
-- pos_idが設定済み（かつ除外されていない）レコードをCSV出力してLinderaユーザー辞書として利用する
CREATE TABLE IF NOT EXISTS unknown_words (
    word             VARCHAR PRIMARY KEY, -- 表層形
    excluded         BOOLEAN DEFAULT false, -- 除外フラグ
    source_docs      VARCHAR,              -- 出現元ドキュメント（複数ある場合はカンマ区切り等）
    note             VARCHAR,              -- 自由記述の補足

    -- ユーザー辞書用カラム（Detailed形式に相当。pos_id以外は初期値を設定）
    left_id          INTEGER DEFAULT 0,    -- 左文脈ID
    right_id         INTEGER DEFAULT 0,    -- 右文脈ID
    cost             INTEGER DEFAULT -1000, -- コスト
    pos_master_id    INTEGER REFERENCES pos_master(id), -- 品詞（NULL = 未レビュー）
    pos_detail1      VARCHAR DEFAULT '*',
    pos_detail2      VARCHAR DEFAULT '*',
    pos_detail3      VARCHAR DEFAULT '*',
    conjugation_type VARCHAR DEFAULT '*',  -- 活用型
    conjugation_form VARCHAR DEFAULT '*',  -- 活用形
    base_form        VARCHAR,              -- 基本形（通常はwordと同じ）
    reading          VARCHAR,              -- 読み（カタカナ、人間が入力）
    pronunciation    VARCHAR,              -- 発音（カタカナ）

    -- レコード管理用
    created          TIMESTAMP DEFAULT current_timestamp, -- 登録日時
    modified         TIMESTAMP DEFAULT current_timestamp  -- 最終更新日時
);
