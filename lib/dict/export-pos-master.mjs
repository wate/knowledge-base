// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview pos_masterテーブルを全カラムCSV(ヘッダーあり)で出力する。
 *
 * 出力したCSVは人間がExcel等で編集し、`dict import-pos-master`でDBに反映する。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs dict export-pos-master               # 出力先: pos-master.csv(実行ディレクトリ直下)
 * knowledge-base.mjs dict export-pos-master -o output.csv # 出力先を指定
 * ```
 */

import { query } from '../db.mjs';

/**
 * メイン処理。
 *
 * pos_masterテーブルの全レコードをCSV(ヘッダーあり)で出力する。
 */
export async function run() {
  const output = argv.o || argv.output || path.resolve(process.cwd(), 'pos-master.csv');

  echo(chalk.bold('\n📤 pos_masterテーブルCSV出力\n'));

  const rows = await query('SELECT * FROM pos_master ORDER BY id');
  echo(chalk.gray(`  レコード数: ${rows.length}`));

  if (rows.length === 0) {
    echo(chalk.yellow('  出力対象のレコードがありません'));
    return;
  }

  const columns = ['id', 'name', 'note'];

  const header = columns.join(',');
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

  const csv = [header, ...lines].join('\n') + '\n';
  fs.writeFileSync(output, csv, 'utf8');

  echo(chalk.green(`  ✅ 出力完了: ${output} (${rows.length}行)`));
}
