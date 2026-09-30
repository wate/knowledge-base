// zx globals: $, argv, fs, path, chalk

/**
 * @fileoverview 辞書の整合チェックと再取得・ユーザー辞書の再ビルド。
 *
 * システム辞書が設定(`dictionary.type`)と一致しない場合は自動で再取得し、
 * ユーザー辞書はシステム辞書の状態にかかわらず常に再ビルドする。
 * `--force`を指定すると、一致していてもシステム辞書を再取得する
 * (Lindera本体の更新などで既存辞書が使えなくなった場合に使う)。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs update-dict                    # 不一致時のみ再取得 + ユーザー辞書の再ビルド
 * knowledge-base.mjs update-dict --force            # 一致していても再取得 + ユーザー辞書の再ビルド
 * knowledge-base.mjs update-dict --csv edited.csv   # 取り込むCSVを指定(既定は実行ディレクトリ直下)
 * ```
 */

import { loadConfig } from './config.mjs';
import { ensureDictionary, isDictionaryConsistent } from './lindera.mjs';

// 既定パスの基準は knowledge-base/ 配下(このモジュールは lib/ にある)
const KB_DIR = path.resolve(import.meta.dirname, '..');

/**
 * ビルド対象のCSVが存在するかで、次に取る動作を決める。
 *
 * 出力対象が0件の場合は`dict export-user-dict`がCSVを出力しないため、
 * `lindera build`へ渡す前に存在を確認する。
 *
 * @param {string} csvPath ユーザー辞書CSVのパス
 * @returns {'build' | 'skip'} 実行する動作
 */
export function decideBuildAction(csvPath) {
  return fs.existsSync(csvPath) ? 'build' : 'skip';
}

/**
 * メイン処理。
 *
 * 1. システム辞書を設定に合わせる(不一致または`--force`の場合は再取得)
 * 2. ユーザー辞書を再ビルドする
 * 3. システム辞書を再取得した場合は`sync --full`を案内する
 *
 * @param {string[]} [rest=[]] サブコマンド以降の引数(未使用)
 * @returns {Promise<void>}
 */
export async function run(rest = []) {
  const force = Boolean(argv.force);
  const config = loadConfig();
  const systemDir = config.dictionary.system_dir;
  const dictType = config.dictionary.type;
  const userDictPath = config.dictionary.user_dict;

  echo(chalk.bold('\n📚 辞書の更新\n'));

  // システム辞書: 一致しない場合(または--force)に再取得する
  const wasConsistent = isDictionaryConsistent(systemDir, dictType);
  await ensureDictionary(systemDir, dictType, { force });
  const systemUpdated = force || !wasConsistent;

  // ユーザー辞書: システム辞書が変わっていなくても常に再ビルドする
  // (未知語の反映はユーザー辞書の再ビルドだけで完結するため)
  const csvPath = path.resolve(argv.csv || 'user-dict.csv');
  const destDir = path.dirname(userDictPath);
  const cliPath = path.resolve(KB_DIR, 'knowledge-base.mjs');

  echo(chalk.bold('\n📤 ユーザー辞書の再ビルド\n'));
  // 既存のCSV出力処理を流用する(新規のCSV出力処理は作らない)
  await $`zx ${cliPath} dict export-user-dict -o ${csvPath}`;

  // 出力対象が0件のときはCSVが出力されない。lindera buildは入力ファイルが必須のためスキップする
  if (decideBuildAction(csvPath) === 'skip') {
    echo(chalk.yellow('  出力対象のレコードが無いため、ユーザー辞書の再ビルドをスキップしました'));
    echo(chalk.gray('  dict export-unknown-words でCSVを出力し、未知語のレビューを先に進めてください。'));
  } else {
    await $`mkdir -p ${destDir}`;
    await $`lindera build --src ${csvPath} --dest ${destDir} --metadata ${path.join(systemDir, 'metadata.json')} --user`;
    echo(chalk.green(`\n  ✅ ユーザー辞書を更新しました: ${userDictPath}`));
  }

  // システム辞書を差し替えた場合は、content_wakati が旧辞書のまま残るため再取り込みを案内する
  if (systemUpdated) {
    echo(chalk.yellow('  ℹ 辞書を再取得したため、次を実行して再取り込みしてください: zx knowledge-base.mjs sync --full'));
  }
}
