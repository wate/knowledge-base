社内用語検出・別名正規化 参考資料
=================================

現状のKBですでにできること
--------------------------

### 社内用語の検出(UNKパイプライン)

`detect-unk.mjs` の未知語検出パイプラインは、社内文書に特有の用語を拾う入口として使えます。

```
社内文書(.md) → detect-unk.mjs → unknown_words(DB)
                                      ↓
                                 export-unknown-words.mjs → CSV(人間レビュー)
                                      ↓
                                 import-unknown-words.mjs → DB反映
                                      ↓
                                 export-user-dict.mjs → Linderaユーザー辞書
                                      ↓
                                 形態素解析で正しく分割されるように
```

この流れの応用で、以下を追加すれば社内用語管理に拡張できます。

### 全文検索・ベクトル検索

- BM25全文検索: 登録済み文書から社内用語を含む箇所を検索
- ベクトル検索: 用語の意味的な類似検索(略称・通称からの類推)

拡張アイデア
-------------------------

### 1. 別名(aliases)の管理

記事のオントロジーでは、1つのエンティティに複数の別名を持たせています。

```yaml
name: hecate
aliases: [Hecate, ヘカテ, 認証認可基盤, ID連携基盤]
```

現状の `unknown_words` テーブルを拡張して別名を管理する案:

```sql
-- 未知語テーブルに別名カラム追加
ALTER TABLE unknown_words ADD COLUMN aliases TEXT; -- カンマ区切りまたはJSON

-- または別名専用テーブル
CREATE TABLE word_aliases (
    id INTEGER PRIMARY KEY,
    word_id INTEGER REFERENCES unknown_words(id),
    alias TEXT NOT NULL,
    alias_type TEXT NOT NULL, -- 'abbreviation', 'synonym', 'nickname', 'misspelling'
    UNIQUE(word_id, alias)
);
```

これにより「hecate」で検索したときに「ヘカテ」「認証認可基盤」でもヒットする、
あるいはその逆が可能になります。

### 2. 表記揺れ正規化モジュール(重点項目)

社内文書で頻出する表記揺れを正規化し、検索・未知語検出の品質を底上げする。
日本語特有の揺れをカバーすることで、同じ用語が別物扱いされるのを防ぐ。

#### 正規化対象とする表記揺れの種類

| #   | カテゴリー              | 揺れの例                                                                   | 正規化後                                                               | 優先度           |
| --- | ----------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| 1   | カタカナ長音            | コンピュー**タ** / コンピュー**ター**、ヘ**カ**テ / ヘ**カ**ーテ           | 長音を外した形で統一(ただし固有名詞系は辞書でメンテ)                   | 高(頻出)         |
| 2   | カタカナの清濁          | インター**フェース** / インター**フェイス**、**データベース** / **デーベ** | 規則的でないため辞書引きが必要。頻出語だけエントリに持つ               | 中               |
| 3   | 全角/半角               | `Ａ`〜`Ｚ` / `A`〜`Z`、`０`〜`９` / `0`〜`9`                               | 半角に統一                                                             | 高(基本)         |
| 4   | 大文字/小文字           | `HEC` / `Hec` / `hec`                                                      | 特に固有名詞は正規化すると区別できなくなる。検索時のみ小文字化でマッチ | 中               |
| 5   | 数字表記                | `第1版` / `第１版` / `第一版`                                              | 半角数字に統一                                                         | 中               |
| 6   | 送り仮名                | `取込み` / `取り込み`、`書換え` / `書き換え`                               | 本則(送る)に統一                                                       | 低               |
| 7   | 日付表記                | `2024/1/1` / `2024-01-01` / `2024年1月1日`                                 | 内部形式に統一(`2024-01-01`)                                           | 低(用途限定)     |
| 8   | アルファベット+カタカナ | `ID基盤` / `Id基盤` / `アイディー基盤`                                     | 辞書引きで正規形に                                                     | 中(社内用語特有) |
| 9   | 漢字/かな混在           | `お問い合わせ` / `お問合せ` / `問い合わせ`                                 | 常用形に統一                                                           | 低               |
| 10  | 約物揺れ                | `•` / `・` / `･`、`(株)` / `（株）`、`ー(長音)` / `−(マイナス)`            | 特定の約物に統一                                                       | 中(ノイズ削減)   |

#### 実装イメージ: 段階的アプローチ

全部を一度にやろうとすると破綻するので、優先度の高いものから段階的に追加する。

```javascript
// lib/normalize.mjs（案）
//
// 表記揺れ正規化モジュール
// 用途: 検索クエリの正規化 / 未知語登録前の正規化 / 文書取り込み時のインデックス用テキスト生成
//
// 使い分けの指針:
//   - searchQuery(text): 検索時に使う。ヒット率を上げるため積極的に正規化
//   - canonicalForm(text): エンティティ名の正規形を生成する。用語管理の基準形
//   - normalizeToken(text): 未知語判定前に使う。ノイズ除去が主目的

/**
 * 全角英数字を半角に変換する。
 *
 * @param {string} s
 * @returns {string}
 */
function toHalfWidth(s) {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0),
  );
}

/**
 * カタカナの長音記号を除去する。
 *
 * コンピューター → コンピュータ
 * ヘカーテ → ヘカテ
 *
 * @param {string} s
 * @returns {string}
 */
function removeProlongedSound(s) {
  // 長音がカタカナの後ろにある場合のみ除去（「データ」の「ー」は除去、「コーポレート」→「コホレト」はやりすぎか判断要）
  return s.replace(/([ァ-ヴ])ー/g, '$1');
}

/**
 * 約物を統一する。
 *
 * 中黒: •・･ → ・（統一）
 * 長音: −(U+2212) → ー(U+30FC)
 */
function normalizePunctuation(s) {
  return s
    .replace(/[•･]/g, '・')
    .replace(/\u2212/g, 'ー'); // マイナス記号→長音
}

/**
 * 検索クエリ用の正規化（積極的）。
 *
 * 検索時に使う。大文字小文字も統一し、ヒット率を最大化する。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSearchQuery(text) {
  let t = text;
  t = toHalfWidth(t);
  t = t.toLowerCase();
  t = removeProlongedSound(t);
  t = normalizePunctuation(t);
  // 必要に応じてさらに追加
  return t;
}

/**
 * エンティティ名の正規形を生成する（保守的）。
 *
 * 字形の揺れだけ吸収し、大文字/小文字の区別は維持する。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeCanonical(text) {
  let t = text;
  t = toHalfWidth(t);
  t = normalizePunctuation(t);
  return t;
}
```

#### 既存パイプラインへの組み込み方

```
[登録時]
文書 → normalizeCanonical(見出し) → Lindera tokenize → content_wakali（FTS用）
  ↓
detect-unk → normalizeToken(未知語候補) → isNoiseToken → DB登録
                                                      ↓
                                          表記揺れを含む同一語の重複登録を防止

[検索時]
クエリ → normalizeSearchQuery → Lindera tokenize → BM25検索
  ↓
searchBM25 → 正規化後テキストでマッチ（表記揺れがあってもヒット）
```

#### 注意点

- 正規化しすぎない: 固有名詞(製品名・コードネーム)は大文字小文字を維持。検索時のみ大文字小文字を吸収
- 辞書引きとの併用: カタカナ清濁(フェース/フェイス)やアルファベット+カタカナ(ID基盤/アイディー基盤)はルールでは対処しきれない。`word_aliases` テーブルで辞書メンテする
- 長音除去の例外:「コーポレート」「サーバー」など一般語の長音除去は、むしろ検索精度を落とす可能性がある。「社内で使われる形」に合わせてチューニングが必要

既存の `detect-unk.mjs` の `isNoiseToken()` と同様、プラグイン方式でルールを追加できる設計にすると応用が効きます。

### 3. 記事の「lookup → expand → seeds」に相当する処理

現状のKBで近いことを実現する対応関係:

| 記事の操作                                 | 現状のKBで使えるもの               | 備考                                                     |
| ------------------------------------------ | ---------------------------------- | -------------------------------------------------------- |
| **lookup**: 名前や別名からエンティティ解決 | `search.mjs --bm25`                | unknown_words/word_aliases をFTS対象にすれば別名検索可能 |
| **expand**: 関係を辿る                     | なし(doc_links は文書間リンクのみ) | エンティティ間の関係テーブルが必要                       |
| **seeds**: 検索語セットを生成              | なし                               | エンティティの別名・関係先からキーワード群を動的生成     |

### 4. エンティティ間の関係

記事では6種類の関係を定義:

```
owned-by（所有）, part-of（所属）, depends-on（依存）,
relates-to（関連）, used-by（利用）, similar-to（類似）
```

これらを管理するテーブルを追加すれば、関係を辿った検索が可能になります。

```sql
CREATE TABLE entity_relations (
    id INTEGER PRIMARY KEY,
    source_entity_id INTEGER NOT NULL,
    target_entity_id INTEGER NOT NULL,
    relation_type TEXT NOT NULL, -- 'owned-by', 'part-of', 'depends-on', ...
    UNIQUE(source_entity_id, target_entity_id, relation_type)
);
```

現状の `doc_links`(文書間リンク → PageRank)とは別に、
エンティティ間の意味的な関係を管理する層として位置づけられます。

### 5. Wikipediaを種とした用語辞書・別名データの生成

Wikipediaの膨大な記事コンテンツそのものではなく、**「どのような用語が存在し、どう読むか、どの分野のものか」**というメタ情報だけを抽出し、初期のユーザー辞書と別名リストとして活用する。

#### 目的

- 初期状態から業界用語をまさしく形態素解析できるようにする
- UNK検出を社内固有語に集中させる(既知の業界用語をノイズとして拾わせない)
- Wikipediaのリダイレクト(正式名→別名)を別名リストとして流用する

#### Wikipediaから抽出できる情報

| 情報                            | データソース                                      | 活用先                       |
| ------------------------------- | ------------------------------------------------- | ---------------------------- |
| 記事タイトル(表記)              | ページ一覧                                        | Linderaユーザー辞書のword    |
| リダイレクト(別名→正式名の対応) | リダイレクトページ                                | `word_aliases` テーブル      |
| カテゴリー(分野・ドメイン)      | カテゴリーリンク                                  | 用語の分野フィルタリング     |
| 読み(ふりがな)                  | `{{読み仮名}}` テンプレート or タイトルのひらがな | Linderaユーザー辞書のreading |

#### 抽出イメージ

```
Wikipediaダンプ (jawiki-latest-pages-articles.xml)
  │
  ├ ページタイトル一覧
  │   ├ "アセトアミノフェン"
  │   ├ "非ステロイド性抗炎症薬"
  │   ├ "クエン酸"
  │   └ …（数十万〜百万件）
  │
  ├ リダイレクト（別名マッピング）
  │   ├ "タイレノール" → "アセトアミノフェン"
  │   ├ "NSAIDs" → "非ステロイド性抗炎症薬"
  │   ├ "Citric acid" → "クエン酸"
  │   └ …
  │
  └ カテゴリフィルタ
      ├ "医療" カテゴリ配下
      ├ "薬学" カテゴリ配下
      ├ "情報工学" カテゴリ配下
      └ …
          │
          ▼ カテゴリでフィルタした用語だけを抽出
          │
          ├ export-user-dict.mjs 形式のCSV → Linderaユーザー辞書
          └ 別名リスト → word_aliases テーブル
```

#### サンプルデータの中身

ユーザー辞書に登録するもの:

```csv
word,pos,reading
非ステロイド性抗炎症薬,名詞,ヒステロイドセイコウエンショウヤク
アセトアミノフェン,名詞,アセトアミノフェン
クエン酸,名詞,クエンサン
```

別名として登録するもの:

```csv
word,alias,alias_type
アセトアミノフェン,タイレノール,synonym
アセトアミノフェン,アセトアミノフェン,synonym
アセトアミノフェン,Acetaminophen,synonym
非ステロイド性抗炎症薬,NSAIDs,abbreviation
非ステロイド性抗炎症薬,非ステロイド性抗炎症薬,synonym
```

これにより、社内文書に「NSAIDs」と書いてあってもまさしく1語として認識され、検索時に「非ステロイド性抗炎症薬」と同義検索できるようになる。

#### カテゴリーフィルタが重要

Wikipediaの全タイトルを使うと一般単語が大量に混入する(「学校」「天気」「好き」「走る」…)。目的の業界に絞るにはカテゴリーフィルタが必須。

```sql
-- イメージ: 「医療」カテゴリ配下のページだけ抽出
-- 実際は categorylinks テーブルを再帰的に辿る
SELECT page_title
FROM wiki_categorylinks
WHERE cl_to IN ('医療', '薬学', '医学', '診断', '治療')
   OR cl_to IN (SELECT cl_to FROM wiki_categorylinks WHERE cl_to = '医療')
```

#### 実装方針

- 新規スクリプト `fetch-wiki-terms.mjs`(仮)として作成
- 処理フロー:
    1. Wikipediaダンプ(XML)をダウンロードorローカルに展開済みのDBを読む
    2. 指定カテゴリー配下のページタイトルを抽出
    3. リダイレクトを解決して正式名→別名マッピングを生成
    4. タイトルの読みを推定(テンプレート参照orひらがな変換API)
    5. ユーザー辞書CSV + 別名CSVの2ファイルを出力
- 既存の `import-unknown-words.mjs`/`export-user-dict.mjs` に流し込める形式にする

#### 別名テーブルのスキーマ(再掲)

```sql
CREATE TABLE word_aliases (
    id INTEGER PRIMARY KEY,
    word_id INTEGER REFERENCES unknown_words(id),
    alias TEXT NOT NULL,
    alias_type TEXT NOT NULL, -- 'abbreviation', 'synonym', 'nickname', 'misspelling'
    UNIQUE(word_id, alias)
);
```

すでにUNK検出で登録された社内固有語と、Wikipedia由来の業界用語を同じテーブルで統一的に扱えるため、lookup(別名解決)の基盤として機能する。

### 6. MCP連携の可能性

記事ではMCP(Model Context Protocol)でAIアシスタントに公開しています。
このKBもMCPサーバーとして公開すれば、同様の連携が可能です。

```
社内文書 → ingest.mjs → DuckDB(KB)
                            ↓
              search.mjs (lookup / expand 相当)
                            ↓
                   MCP Server（構想中）
                            ↓
              AIアシスタント / エージェント
```

今後の検討材料との対応
-------------------------

READMEの「今後の検討材料」との対応:

| 検討項目                               | 関連する拡張                                    |
| -------------------------------------- | ----------------------------------------------- |
| 設定ファイル対応(ノイズフィルタ外部化) | 略語正規化ルールの外部化と共通化できる          |
| 変換後処理パイプライン(Phase 3)        | 未知語→エンティティカードの自動生成パイプライン |
| Webインターフェース/API                | エンティティ管理UI、関係グラフ可視化            |

参考リンク
-------------------------

- [AIに会社の地図を持たせたら、3年目社員のように働き始めた](https://note.com/ymdpharm3/n/n8515d151e56d)
- [Y Combinator: Company Brain](https://www.ycombinator.com/rfs#company-brain)
- [Andrej Karpathy: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c18b53f8ed3)
