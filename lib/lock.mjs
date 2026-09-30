// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview CLIの排他制御(ファイルベースのアトミックロック)
 *
 * DuckDBのロックとは独立に、`O_EXCL`で作成するロックファイルで
 * DBを書き換えるサブコマンドの二重起動を防ぐ。
 * ロックが取得できない場合は待機せず、理由を表示してexit 1とする。
 */

import { loadConfig } from './config.mjs';

/**
 * ロックファイルのパスを返す(DBと同じディレクトリ)。
 *
 * @returns {string}
 */
function lockPath() {
  const config = loadConfig();
  return `${config.database.path}.lock`;
}

/**
 * 指定PIDのプロセスが生存しているかを返す。
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // 権限がない場合は生存とみなす(別ユーザーのプロセス)
    return e.code === 'EPERM';
  }
}

/**
 * ロックを取得する。取得できなければ例外を投げる。
 *
 * ロックファイルにはPIDを書き込む。前回のプロセスが終了している場合は
 * 残存ロックとみなして引き継ぐ(クラッシュ後に永久に起動できなくなるのを防ぐ)。
 *
 * @returns {string} 取得したロックファイルのパス
 */
export function acquireLock() {
  const file = lockPath();

  try {
    const fd = fs.openSync(file, 'wx'); // O_CREAT|O_EXCL によるアトミックな作成
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return file;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  // 既存ロックのPIDが生きていれば二重起動
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  if (pid && pid !== process.pid && isAlive(pid)) {
    throw new Error(`他のプロセスが実行中です(pid ${pid})。ロックファイル: ${file}`);
  }

  // 残存ロック(プロセス終了済み)は引き継ぐ
  fs.writeFileSync(file, String(process.pid));
  return file;
}

/**
 * ロックを解放する。
 *
 * @param {string} file ロックファイルのパス
 */
export function releaseLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // すでに削除されている場合は無視する(意図的なフォールバック)
  }
}
