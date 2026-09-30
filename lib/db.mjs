/**
 * @fileoverview DuckDB接続の共通モジュール
 *
 * @duckdb/node-api を使用したコネクション管理 + クエリ実行関数。
 * コネクションは遅延初期化（初回クエリ時に生成）し、プロセス内で再利用する。
 *
 * CLI経由の一時ファイル方式（duckdb DB -json < file.sql）からの移行先。
 * パラメタライズドクエリ（$1, $2形式）に対応し、SQLインジェクションを防止する。
 *
 * @usage
 * ```js
 * import { query, execute, exec, close } from './lib/db.mjs';
 *
 * // SELECT
 * const rows = await query('SELECT * FROM documents WHERE id = $1', [1]);
 *
 * // INSERT/UPDATE/DELETE
 * await execute('UPDATE documents SET content = $1 WHERE id = $2', ['new content', 1]);
 *
 * // 複数ステートメント（トランザクション用）
 * await exec('BEGIN TRANSACTION; DELETE FROM chapters; COMMIT;');
 *
 * // 明示的クローズ
 * close();
 * ```
 */

import duckdb from '@duckdb/node-api';
import { loadConfig } from './config.mjs';

/** @type {import('@duckdb/node-api').DuckDBConnection|null} */
let _connection = null;
let _instance = null;

/**
 * スキーマが存在しない場合、docs/schema.sql を実行して初期化する。
 *
 * documents テーブルの存在確認を行い、存在しない場合は
 * スキーマファイルを読み込んでDDLを実行する。
 *
 * @param {import('@duckdb/node-api').DuckDBConnection} conn
 * @returns {Promise<void>}
 */
async function ensureSchema(conn) {
  try {
    const result = await conn.runAndReadAll(
      "SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_name = 'documents' AND table_schema = 'main'",
    );
    const rows = result.getRowObjects();
    if (rows.length > 0 && Number(rows[0].cnt) > 0) return;
  } catch {
    // テーブルが存在しない場合、続行してスキーマを実行
  }

  const schemaPath = path.resolve(import.meta.dirname, '../docs/schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(chalk.yellow(`  ⚠ スキーマファイルが見つかりません: ${schemaPath}`));
    return;
  }

  const schema = fs.readFileSync(schemaPath, 'utf8');
  await conn.run(schema);
  console.error(chalk.green('  ✅ データベーススキーマを初期化しました'));
}

/**
 * DuckDBインスタンスを生成し、コネクションを取得する。
 *
 * 初回呼び出し時に loadConfig() から DB パスを読み込み、
 * DuckDBInstance.create() → instance.connect() でコネクションを確立する。
 * 2回目以降は生成済みのコネクションを返す。
 * 初回接続時にスキーマが存在しなければ自動的に初期化する。
 *
 * @returns {Promise<import('@duckdb/node-api').DuckDBConnection>}
 */
async function getConnection() {
  if (_connection) return _connection;
  const config = loadConfig();
  const instance = await duckdb.DuckDBInstance.create(config.database.path);
  _instance = instance;
  _connection = await instance.connect();
  await ensureSchema(_connection);
  return _connection;
}

/**
 * SELECTクエリを実行し、結果をオブジェクト配列として返す。
 *
 * @param {string} sql SQLクエリ（$1, $2形式の位置パラメータを使用可能）
 * @param {Array} [params] パラメータ値の配列（省略時はパラメータなし）
 * @returns {Promise<object[]>} クエリ結果のオブジェクト配列
 * @throws {Error} クエリ実行失敗時
 */
export async function query(sql, params) {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjects();
}

/**
 * INSERT/UPDATE/DELETE クエリを実行する（結果出力なし）。
 *
 * @param {string} sql SQLクエリ（$1, $2形式の位置パラメータを使用可能）
 * @param {Array} [params] パラメータ値の配列（省略時はパラメータなし）
 * @returns {Promise<void>}
 * @throws {Error} クエリ実行失敗時
 */
export async function execute(sql, params) {
  const conn = await getConnection();
  await conn.run(sql, params);
}

/**
 * 複数ステートメントを一括実行する（トランザクション用）。
 *
 * パラメータバインドは行わない。パラメータが必要なクエリは
 * query() または execute() を使用すること。
 *
 * @param {string} sql 実行するSQL（複数ステートメントは;区切りで連結）
 * @returns {Promise<void>}
 * @throws {Error} クエリ実行失敗時
 */
export async function exec(sql) {
  const conn = await getConnection();
  await conn.run(sql);
}

/**
 * コネクションとインスタンスを明示的に解放する。
 *
 * サブプロセス起動前に呼び出すことで、DBファイルのロック競合を防止する。
 * 通常はプロセス終了時に自動クローズされるため、明示的な呼び出しは
 * サブプロセス起動前や長時間稼働プロセスでのリソース解放時に限定してよい。
 */
export function close() {
  if (_connection) {
    try { _connection.closeSync(); } catch { /* すでに閉じられている場合は無視する(意図的なフォールバック) */ }
    _connection = null;
  }
  if (_instance) {
    try { _instance.closeSync(); } catch { /* すでに閉じられている場合は無視する(意図的なフォールバック) */ }
    _instance = null;
  }
}
