#!/usr/bin/env zx
// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview 単体テストの実行入口
 *
 * `knowledge-base/lib/` のモジュールはzxがグローバル注入する変数(fs・path・echo等)に依存するため、
 * 素の`node --test`では実行できない。zx経由でnode標準のnode:testを実行し、グローバルを注入する。
 * 依存パッケージは追加しない。
 *
 * @usage
 *   npm test                     # 失敗があればexit 1
 *   KB_TEST_EMBED=1 npm test     # embeddingモデルを使うテストも実行する
 */

import { run } from 'node:test';
import { finished } from 'node:stream/promises';
import { spec } from 'node:test/reporters';

const files = (await glob('tests/*.test.mjs')).sort();
if (files.length === 0) {
  echo(chalk.yellow('テストファイルが見つかりません: tests/*.test.mjs'));
  process.exit(1);
}

echo(chalk.gray(`対象: ${files.map((f) => path.basename(f)).join(', ')}\n`));

let failed = 0;
// isolation:'none' で同一プロセス実行にする(zxのグローバルをテストファイルへ引き継ぐため)
const stream = run({ files, concurrency: 1, timeout: 120000, isolation: 'none' });
stream.on('test:fail', () => {
  failed += 1;
});
stream.compose(new spec()).pipe(process.stdout);

await finished(stream);

echo(chalk.gray(`\n失敗: ${failed}件 / 対象 ${files.length}ファイル`));
process.exit(failed > 0 ? 1 : 0);
