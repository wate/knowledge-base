// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview 編集済み unknown-words.csv を unknown_words テーブルに一括取り込む。
 *
 * CSVのカラム構成は`dict export-unknown-words`の出力と同一であることを前提とする。
 * pos_name(品詞名)は自動的にpos_masterテーブルを検索してpos_master_idに解決される。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs dict import-unknown-words               # unknown-words.csv(実行ディレクトリ直下)
 * knowledge-base.mjs dict import-unknown-words edited.csv    # 任意のファイルを指定
 * knowledge-base.mjs dict import-unknown-words --input e.csv # 任意のファイルを指定
 * ```
 */

import { query, execute } from '../db.mjs';

/**
 * メイン処理。
 *
 * CSVを読み込み、pos_nameをpos_master_idに解決してunknown_wordsテーブルにUPSERTする。
 *
 * @param {string[]} rest 入力ファイル(省略時は実行ディレクトリ直下のunknown-words.csv)
 */
export async function run(rest = []) {
  const input = argv.input || rest[0] || path.resolve(process.cwd(), 'unknown-words.csv');

  echo(chalk.bold('\n📥 unknown_wordsテーブルCSV取り込み\n'));

  const csvPath = path.resolve(input);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`ファイルが見つかりません: ${csvPath}`);
  }
  echo(chalk.gray(`  入力: ${csvPath}`));

  // 取り込み前レコード数
  const before = await query('SELECT COUNT(*) AS cnt FROM unknown_words');
  const beforeCount = Number(before[0]?.cnt ?? 0);
  echo(chalk.gray(`  取り込み前: ${beforeCount} 件`));

  // CSV を読み込み、pos_name を pos_master_id に解決して UPSERT
  const safePath = csvPath.replace(/'/g, "''");
  const sql = `
    WITH csv_import AS (
      SELECT * FROM read_csv_auto('${safePath}',
        header    := true,
        all_varchar := true
      )
    )
    INSERT INTO unknown_words (
      word, pos_master_id, excluded, note, source_docs,
      left_id, right_id, cost,
      pos_detail1, pos_detail2, pos_detail3,
      conjugation_type, conjugation_form,
      base_form, reading, pronunciation,
      modified
    )
    SELECT
      csv.word,
      CASE WHEN NULLIF(csv.pos_name, '') IS NULL THEN NULL ELSE pm.id END,
      csv.excluded = 'true',
      NULLIF(csv.note, ''),
      NULLIF(csv.source_docs, ''),
      CASE WHEN csv.left_id = '' THEN 0 ELSE csv.left_id::INTEGER END,
      CASE WHEN csv.right_id = '' THEN 0 ELSE csv.right_id::INTEGER END,
      CASE WHEN csv.cost = '' THEN -1000 ELSE csv.cost::INTEGER END,
      csv.pos_detail1,
      csv.pos_detail2,
      csv.pos_detail3,
      csv.conjugation_type,
      csv.conjugation_form,
      COALESCE(NULLIF(csv.base_form, ''), csv.word),
      csv.reading,
      csv.pronunciation,
      now()
    FROM csv_import csv
    LEFT JOIN pos_master pm ON csv.pos_name = pm.name
    ON CONFLICT (word) DO UPDATE SET
      pos_master_id     = EXCLUDED.pos_master_id,
      excluded          = EXCLUDED.excluded,
      note              = EXCLUDED.note,
      source_docs       = EXCLUDED.source_docs,
      left_id           = EXCLUDED.left_id,
      right_id          = EXCLUDED.right_id,
      cost              = EXCLUDED.cost,
      pos_detail1       = EXCLUDED.pos_detail1,
      pos_detail2       = EXCLUDED.pos_detail2,
      pos_detail3       = EXCLUDED.pos_detail3,
      conjugation_type  = EXCLUDED.conjugation_type,
      conjugation_form  = EXCLUDED.conjugation_form,
      base_form         = EXCLUDED.base_form,
      reading           = EXCLUDED.reading,
      pronunciation     = EXCLUDED.pronunciation,
      modified          = now()
  `;

  await execute(sql);

  // 取り込み後レコード数
  const after = await query('SELECT COUNT(*) AS cnt FROM unknown_words');
  const afterCount = Number(after[0]?.cnt ?? 0);
  const delta = afterCount - beforeCount;

  echo(chalk.green('  ✅ 取り込み完了'));
  echo(chalk.gray(`  取り込み後: ${afterCount} 件 (変化: ${delta >= 0 ? '+' : ''}${delta})`));
  if (delta === 0) {
    echo(chalk.cyan('  ℹ️  既存レコードの更新のみ実行されました'));
  }
}
