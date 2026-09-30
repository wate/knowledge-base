// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview 編集済み pos-master.csv を pos_master テーブルに一括取り込む。
 *
 * CSVのカラム構成は`dict export-pos-master`の出力と同一であることを前提とする。
 * idをキーにUPSERTし、既存レコードはname・noteをUPDATE、新規idのレコードはINSERTする。
 * idが空の行(新規追加行)は自動採番でINSERTされる。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs dict import-pos-master               # pos-master.csv(実行ディレクトリ直下)
 * knowledge-base.mjs dict import-pos-master edited.csv    # 任意のファイルを指定
 * knowledge-base.mjs dict import-pos-master --input e.csv # 任意のファイルを指定
 * ```
 */

import { query, execute } from '../db.mjs';

/**
 * メイン処理。
 *
 * CSVを読み込み、pos_masterテーブルにUPSERTする。
 * idあり行はUPSERT、idなし行(新規追加行)は自動採番でINSERTされる。
 *
 * @param {string[]} rest 入力ファイル(省略時は実行ディレクトリ直下のpos-master.csv)
 */
export async function run(rest = []) {
  const input = argv.input || rest[0] || path.resolve(process.cwd(), 'pos-master.csv');

  echo(chalk.bold('\n📥 pos_masterテーブルCSV取り込み\n'));

  const csvPath = path.resolve(input);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`ファイルが見つかりません: ${csvPath}`);
  }
  echo(chalk.gray(`  入力: ${csvPath}`));

  const before = await query('SELECT COUNT(*) AS cnt FROM pos_master');
  const beforeCount = Number(before[0]?.cnt ?? 0);
  echo(chalk.gray(`  取り込み前: ${beforeCount} 件`));

  // id あり行は UPSERT、id なし行(空文字)は新規INSERT
  const safePath = csvPath.replace(/'/g, "''");
  const csvCTE = `
    WITH csv_import AS (
      SELECT * FROM read_csv_auto('${safePath}',
        header    := true,
        all_varchar := true
      )
    )
  `;

  // Step 1: id あり行を UPSERT
  const upsertSQL = csvCTE + `
    INSERT INTO pos_master (id, name, note)
    SELECT csv.id::INTEGER, csv.name, NULLIF(csv.note, '')
    FROM csv_import csv
    WHERE NULLIF(csv.id, '') IS NOT NULL
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      note = EXCLUDED.note
  `;

  // Step 2: id なし行(新規追加)を INSERT
  const insertSQL = csvCTE + `
    INSERT INTO pos_master (name, note)
    SELECT csv.name, NULLIF(csv.note, '')
    FROM csv_import csv
    WHERE NULLIF(csv.id, '') IS NULL
      AND NULLIF(csv.name, '') IS NOT NULL
  `;

  echo(chalk.gray('  Step 1: 既存レコードの更新...'));
  await execute(upsertSQL);
  echo(chalk.gray('  Step 2: 新規レコードの追加...'));
  await execute(insertSQL);

  const after = await query('SELECT COUNT(*) AS cnt FROM pos_master');
  const afterCount = Number(after[0]?.cnt ?? 0);
  const delta = afterCount - beforeCount;

  echo(chalk.green('  ✅ 取り込み完了'));
  echo(chalk.gray(`  取り込み後: ${afterCount} 件 (変化: ${delta >= 0 ? '+' : ''}${delta})`));
  if (delta > 0) {
    echo(chalk.cyan(`  ℹ️  新規追加: ${delta} 件`));
  }
}
