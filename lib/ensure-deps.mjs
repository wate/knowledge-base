// zx globals: $, fs, path, chalk

/**
 * @fileoverview npm依存パッケージの存在確認と自動インストール
 *
 * 配布先では `scripts/node_modules` が存在しない状態で初回起動する。
 * 依存パッケージを使うモジュールは、読み込み時に `import` が評価されるため、
 * コマンドの実行前にこのモジュールで依存を満たしておく必要がある。
 *
 * 呼び出し側の例:
 * ```js
 * import { ensureDependencies } from './ensure-deps.mjs';
 *
 * await ensureDependencies();
 * ```
 */

// 基準ディレクトリは knowledge-base/ 配下(このモジュールは lib/ にある)
const KB_DIR = path.resolve(import.meta.dirname, '..');
const NODE_MODULES_PATH = path.resolve(KB_DIR, 'node_modules');
const PACKAGE_JSON_PATH = path.resolve(KB_DIR, 'package.json');

/**
 * 必要なnpm依存パッケージがインストールされているか確認し、
 * 不足があれば自動で npm install を実行する。
 *
 * @returns {Promise<void>}
 */
export async function ensureDependencies() {
  const { dependencies = {} } = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const missingPackages = Object.keys(dependencies).filter(
    (pkg) => !fs.existsSync(path.join(NODE_MODULES_PATH, pkg)),
  );

  if (missingPackages.length === 0) return;

  echo(chalk.yellow(`依存パッケージが不足しています: ${missingPackages.join(', ')}`));
  echo(chalk.yellow('npm install を実行します...'));
  // cd()ではなくcwdオプションを使う。プロセスの作業ディレクトリを変えると、
  // 以降の相対パス解決(設定の`sources`や`database.path`)の基準がずれるため
  await $({ cwd: KB_DIR })`npm install`;
  echo(chalk.green('npm install 完了'));
}
