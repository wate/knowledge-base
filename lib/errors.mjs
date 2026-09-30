/**
 * @fileoverview CLI共通のエラー型。
 *
 * CLI(`knowledge-base.mjs`)は`UsageError`を「使い方・設定エラー」として扱い、exit 2を返す。
 * 各サブコマンドのモジュールは、引数の誤りを検出したときにこの型を投げる。
 */

/**
 * 使い方・設定エラー(exit 2)を表すエラー。
 */
export class UsageError extends Error {}
