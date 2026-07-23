未知語メンテナンスガイド
=========================

目的
-------------------------

Linderaの標準辞書(ipadic)ではプロジェクト固有の用語(製品名・APIメソッド名・社内略語など)が正しく分割されない。本ドキュメントでは、未知語(UNK)の検出からレビュー、ユーザー辞書への反映までのメンテナンス手順を説明する。

全体フロー
-------------------------

```
detect-unk.mjs              ← 対象ディレクトリの.mdファイルをスキャン
    │
    ▼
unknown_words (DuckDB)      ← 未知語候補のDB
    │
    ├ export-unknown-words.mjs → unknown-words.csv (編集用)
    │                            ↓ 人間がExcel等で編集
    └ import-unknown-words.mjs ← 編集済みCSV → DB反映
    │
    ├ export-pos-master.mjs → pos-master.csv
    │                            ↓ 人間が編集
    └ import-pos-master.mjs ← 編集済みCSV → DB反映
    │
    ├ export-user-dict.mjs  → user-dict.csv (Linderaビルド用)
    └ npm run build-user-dict → user_dictionary/user-dict.bin
    │
    ▼
ingest.mjs                   ← 次回取り込みからユーザー辞書が適用される
```

1. 未知語の検出

### 全ドキュメントを対象に検出

```bash
cd knowledge-base
npm run detect-unk -- --source-dir ../docs --source-dir external/cakephp
```

`--source-dir` で対象ディレクトリを指定する(複数指定可)。未指定時はカレントディレクトリを対象とする。

### 特定のディレクトリのみを対象に検出

```bash
npm run detect-unk -- --source-dir ../docs
```

### ノイズフィルタの調整

`detect-unk.mjs` 先頭の3つのフィルタ配列で除外パターンを調整できる。

| フィルタ               | 対象         | デフォルトのパターン                 |
| ---------------------- | ------------ | ------------------------------------ |
| `preFilters`           | 全トークン   | ASCII記号のみ、記号+日本語句読点のみ |
| `JAPANESE_FILTERS`     | 日本語を含む | 単独漢字1文字、先頭/末尾に中黒       |
| `NON_JAPANESE_FILTERS` | 日本語以外   | 英小文字のみ、数字のみ、2文字以下    |

1. CSVによるメンテナンス

### レビュー用CSVの出力

```bash
npm run export-unknown-words
```

出力先: `schema/dict/unknown-words.csv`(全カラム、ヘッダーあり)

CSVをExcelやVS Codeで開き、以下のカラムを編集する。

| カラム          | 編集内容                                          |
| --------------- | ------------------------------------------------- |
| `pos_name`      | 品詞名を入力(カスタム名詞/固有名詞/一般名詞 など) |
| `excluded`      | 除外する場合は `true` に変更                      |
| `note`          | 任意の補足(除外理由など)                          |
| `reading`       | 読みをカタカナで入力(ユーザー辞書に必須)          |
| `pronunciation` | 発音(readingと同じ場合は空欄でよい)               |
| `base_form`     | 基本形(wordと同じ場合は空欄でよい)                |

### 編集済みCSVの取り込み

```bash
# デフォルトのunknown-words.csvを取り込み
npm run import-unknown-words

# 任意のCSVを指定
npm run import-unknown-words -- path/to/edited.csv
```

CSVの `pos_name` は自動的に `pos_master` テーブルとJOINして解決される。

### 品詞マスタのメンテナンス

```bash
# 出力
npm run export-pos-master

# 編集後の取り込み（idあり=UPDATE、idなし=新規INSERT）
npm run import-pos-master
```

1. ユーザー辞書のビルド

### ビルド用CSVの出力

```bash
# Simple形式（3カラム: 表層形,品詞,読み）
npm run export-user-dict

# Detailed形式（13カラム）
npm run export-user-dict-detailed
```

出力対象は `pos_master_id` が設定済みかつ `excluded = false` のレコードのみ。

### コンパイル

```bash
npm run build-user-dict
```

上記で `export-user-dict` + `lindera build --user` が順次実行され、
`schema/dict/user_dictionary/user-dict.bin` が生成される。

### 分かち書きの確認

```bash
echo "DuckDBとCakePHPを利用する" | lindera tokenize \
  --dict schema/dict/lindera-ipadic \
  --user-dict schema/dict/user_dictionary/user-dict.bin \
  -o wakati
```

1. SQLによる直接メンテナンス

### レビュー対象の確認

```sql
SELECT word, source_docs
FROM unknown_words
WHERE pos_master_id IS NULL AND excluded = false;
```

### 採用(品詞と読みを設定)

```sql
UPDATE unknown_words
SET
  pos_master_id = (SELECT id FROM pos_master WHERE name = 'カスタム名詞'),
  reading = '読みカタカナ',
  modified = now()
WHERE word = '対象の単語';
```

### 除外

```sql
UPDATE unknown_words
SET
  excluded = true,
  note = '除外理由',
  modified = now()
WHERE word = '対象の単語';
```

### 品詞マスタの確認

```sql
SELECT * FROM pos_master ORDER BY id;
```

1. ユーザー辞書の効果確認

---

ユーザー辞書が `ingest.mjs` の分かち書きに反映されているかは、取り込み後の `chapters.content_wakati` で確認できる。

```sql
SELECT content_wakati
FROM chapters
WHERE content LIKE '%対象の単語%'
LIMIT 1;
```

関連ファイル
-------------------------

- `detect-unk.mjs` - 未知語検出スクリプト
- `export-unknown-words.mjs` - レビュー用CSV出力
- `import-unknown-words.mjs` - レビュー用CSV取り込み
- `export-pos-master.mjs` - 品詞マスタCSV出力
- `import-pos-master.mjs` - 品詞マスタCSV取り込み
- `export-user-dict.mjs` - ユーザー辞書ビルド用CSV出力
- `schema/dict/unknown-words.csv` - レビュー用CSV
- `schema/dict/pos-master.csv` - 品詞マスタCSV
- `schema/dict/user-dict.csv` - ビルド用CSV
- `schema/dict/user_dictionary/user-dict.bin` - コンパイル済みユーザー辞書
