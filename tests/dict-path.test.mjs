/**
 * @fileoverview 辞書メンテナンス用CSVの入出力パスの単体テスト
 *
 * 既定の入出力先は実行ディレクトリ直下、入力は`--input`>位置引数の順で決まる。
 * ファイルが無い場合はDBへ触れる前に例外になるため、そのメッセージで解決先を検証する。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { run as importUnknownWords } from '../lib/dict/import-unknown-words.mjs';
import { run as importPosMaster } from '../lib/dict/import-pos-master.mjs';

/**
 * argvを差し替えてrun()を実行し、投げられたErrorを返す。
 *
 * @param {object} argv 差し替えるargv
 * @param {Function} runFn 実行するrun関数
 * @param {string[]} [rest=[]] 位置引数
 * @returns {Promise<Error>} 投げられたエラー
 */
async function runWithArgv(argv, runFn, rest = []) {
  const before = globalThis.argv;
  globalThis.argv = argv;
  try {
    await runFn(rest);
    throw new Error('例外が発生しませんでした');
  } catch (e) {
    return e;
  } finally {
    globalThis.argv = before;
  }
}

test('import-unknown-words: 引数なしは実行ディレクトリ直下のCSVを見る', async () => {
  const err = await runWithArgv({}, importUnknownWords);

  assert.match(err.message, /ファイルが見つかりません/);
  assert.equal(err.message.includes(path.resolve('unknown-words.csv')), true);
});

test('import-unknown-words: --inputの指定を優先する', async () => {
  const specified = path.join(os.tmpdir(), 'kb-missing-unknown.csv');
  const err = await runWithArgv({ input: specified }, importUnknownWords);

  assert.equal(err.message.includes(specified), true);
});

test('import-unknown-words: 位置引数の指定を優先する', async () => {
  const specified = path.join(os.tmpdir(), 'kb-missing-positional.csv');
  const err = await runWithArgv({}, importUnknownWords, [specified]);

  assert.equal(err.message.includes(specified), true);
});

test('import-pos-master: 引数なしは実行ディレクトリ直下のCSVを見る', async () => {
  const err = await runWithArgv({}, importPosMaster);

  assert.equal(err.message.includes(path.resolve('pos-master.csv')), true);
});
