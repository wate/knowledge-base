// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview unknown_wordsテーブルからLinderaユーザー辞書ビルド用CSVを出力する。
 *
 * 既定はSimple形式(3カラム: 表層形,品詞,読み)で出力する。
 * `--detailed`オプションでDetailed形式(13カラム)に切り替え可能。
 * 出力されるのはpos_master_idが設定済みかつexcluded = falseのレコードのみ。
 * CSVヘッダー行は含めない(Linderaの仕様)。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs dict export-user-dict                 # Simple形式(既定は実行ディレクトリ直下)
 * knowledge-base.mjs dict export-user-dict --detailed      # Detailed形式
 * knowledge-base.mjs dict export-user-dict -o output.csv   # 出力先指定
 * ```
 */

import { query } from '../db.mjs';

/**
 * メイン処理。
 *
 * unknown_wordsテーブルからレコードを取得し、
 * Linderaユーザー辞書ビルド用CSVを出力する。
 */
export async function run() {
  const output = argv.o || argv.output || path.resolve(process.cwd(), 'user-dict.csv');
  const isDetailed = argv.detailed || argv.D || false;

  echo(chalk.bold(`\n📤 ユーザー辞書CSV出力 (${isDetailed ? 'Detailed' : 'Simple'}形式)\n`));

  // 出力対象レコードを取得
  let sql;
  if (isDetailed) {
    sql = `
      SELECT
        uw.word, uw.left_id, uw.right_id, uw.cost, pm.name AS pos,
        uw.pos_detail1, uw.pos_detail2, uw.pos_detail3,
        uw.conjugation_type, uw.conjugation_form,
        COALESCE(uw.base_form, uw.word) AS base_form,
        uw.reading,
        COALESCE(uw.pronunciation, uw.reading) AS pronunciation
      FROM unknown_words uw
      JOIN pos_master pm ON uw.pos_master_id = pm.id
      WHERE uw.pos_master_id IS NOT NULL AND uw.excluded = false
      ORDER BY uw.word
    `;
  } else {
    sql = `
      SELECT uw.word, pm.name AS pos, uw.reading
      FROM unknown_words uw
      JOIN pos_master pm ON uw.pos_master_id = pm.id
      WHERE uw.pos_master_id IS NOT NULL AND uw.excluded = false
      ORDER BY uw.word
    `;
  }

  const rows = await query(sql);
  echo(chalk.gray(`  出力対象レコード数: ${rows.length}`));

  if (rows.length === 0) {
    echo(chalk.yellow('  出力対象のレコードがありません(レビュー済みの未知語がないため)'));
    echo(chalk.yellow('  knowledge-base.mjs dict export-unknown-words でCSVを出力し、unknown_words のレビューを先に進めてください。'));
    return;
  }

  // CSV出力(ヘッダーなし)
  const columns = isDetailed
    ? ['word', 'left_id', 'right_id', 'cost', 'pos', 'pos_detail1', 'pos_detail2', 'pos_detail3', 'conjugation_type', 'conjugation_form', 'base_form', 'reading', 'pronunciation']
    : ['word', 'pos', 'reading'];

  const lines = rows.map((row) => {
    return columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',');
  });

  const csv = lines.join('\n') + '\n';
  fs.writeFileSync(output, csv, 'utf8');

  echo(chalk.green(`  ✅ 出力完了: ${output} (${rows.length}行, ${columns.length}カラム)`));
}
