// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview unknown_wordsテーブルを全カラムCSV(ヘッダーあり)で出力する。
 *
 * 出力したCSVは人間がExcel等で編集し、`dict import-unknown-words`でDBに反映する。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs dict export-unknown-words               # 出力先: unknown-words.csv(実行ディレクトリ直下)
 * knowledge-base.mjs dict export-unknown-words -o output.csv # 出力先を指定
 * ```
 */

import { query } from '../db.mjs';

/**
 * メイン処理。
 *
 * unknown_wordsテーブルの全レコードをCSV(ヘッダーあり)で出力する。
 * pos_nameはJOINして表示する。
 */
export async function run() {
  const output = argv.o || argv.output || path.resolve(process.cwd(), 'unknown-words.csv');

  echo(chalk.bold('\n📤 unknown_wordsテーブルCSV出力\n'));

  // 1. unknown_wordsテーブルから全レコードを取得(品詞名はJOINして表示)
  const rows = await query(`
    SELECT uw.*, pm.name AS pos_name
    FROM unknown_words uw
    LEFT JOIN pos_master pm ON uw.pos_master_id = pm.id
    ORDER BY uw.word
  `);
  echo(chalk.gray(`  レコード数: ${rows.length}`));

  if (rows.length === 0) {
    echo(chalk.yellow('  出力対象のレコードがありません'));
    return;
  }

  // 2. カラム順を定義(pos_master_idの代わりに品詞名pos_nameを出力)
  const columns = [
    'word', 'pos_name', 'excluded', 'note', 'source_docs',
    'left_id', 'right_id', 'cost',
    'pos_detail1', 'pos_detail2', 'pos_detail3',
    'conjugation_type', 'conjugation_form',
    'base_form', 'reading', 'pronunciation',
    'created', 'modified',
  ];

  // 3. CSV出力(ヘッダーあり)
  const header = columns.join(',');
  const lines = rows.map((row) => {
    return columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return '';
      const str = String(val);
      // カンマ・ダブルクォートを含む場合はエスケープ
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',');
  });

  const csv = [header, ...lines].join('\n') + '\n';
  fs.writeFileSync(output, csv, 'utf8');

  echo(chalk.green(`  ✅ 出力完了: ${output} (${rows.length}行)`));
}
