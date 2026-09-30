#!/usr/bin/env zx
// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview ナレッジベース統合エントリポイント
 *
 * .knowledge-base.yml の sources 定義に従い、
 * collect → ingest → update-embeddings のパイプラインを一括実行する。
 *
 * @usage
 *   zx knowledge-base.mjs sync                     # 全ソース取り込み＋差分更新
 *   zx knowledge-base.mjs sync <src>               # 指定ソースのみ処理
 *   zx knowledge-base.mjs sync --full              # 全ソースフル再取り込み
 *   zx knowledge-base.mjs sync --local-only        # ローカルソースのみ処理
 *   zx knowledge-base.mjs sync --skip-embed        # embedding生成をスキップ
 *   zx knowledge-base.mjs sync --skip-pagerank     # PageRank更新をスキップ
 *   zx knowledge-base.mjs sync --limit 5           # 各ソース先頭5件のみ
 *   zx knowledge-base.mjs sync --config custom.yml # 設定ファイルを指定
 *   zx knowledge-base.mjs --help                   # サブコマンド一覧
 */

import { ConfigValidationError } from './lib/config.mjs';
import { UsageError } from './lib/errors.mjs';
import { ensureDependencies } from './lib/ensure-deps.mjs';
import { acquireLock, releaseLock } from './lib/lock.mjs';



// ---- CLI(サブコマンドの振り分けとエラー契約) ----

const PROG = 'knowledge-base';

/** サブコマンド定義。run未指定のものは移行中として扱う。 */
const COMMANDS = {
  sync: {
    summary: 'ソースを取り込み、索引を更新する',
    usage: `${PROG} sync [<src>] [--full] [--dry-run] [--local-only] [--skip-embed] [--skip-pagerank] [--limit N] [--config FILE]`,
    run: async (rest) => (await import('./lib/sync.mjs')).run(rest),
  },
  search: {
    summary: 'BM25・ベクトル・ハイブリッド検索',
    usage: `${PROG} search <query> [--vector|--hybrid] [--top N] [--json]`,
    run: async (rest) => (await import('./lib/search.mjs')).run(rest),
  },
  'update-embeddings': {
    summary: 'embedding生成(未生成分のみ)',
    usage: `${PROG} update-embeddings [--limit N]`,
    run: async (rest) => (await import('./lib/update-embeddings.mjs')).run(rest),
  },
  'update-pagerank': {
    summary: 'リンク解析とPageRank更新',
    usage: `${PROG} update-pagerank [<dir>...] [--exclude PATTERN] [--scope SCOPE]`,
    run: async (rest) => (await import('./lib/update-pagerank.mjs')).run(rest),
  },
  'update-dict': {
    summary: '辞書の整合チェックと再取得・ユーザー辞書の再ビルド',
    usage: `${PROG} update-dict [--force] [--csv FILE]`,
    run: async (rest) => (await import('./lib/update-dict.mjs')).run(rest),
  },
  dict: {
    summary: '辞書メンテナンス(未知語検出・CSV入出力)',
    usage: `${PROG} dict <detect|export-unknown-words|import-unknown-words|export-pos-master|import-pos-master|export-user-dict> [--input FILE] [options]`,
    run: runDict,
  },
};

/**
 * `dict`の操作一覧。未移行の操作はnull(移行後に動的importへ差し替える)。
 */
const DICT_OPERATIONS = {
  detect: () => import('./lib/dict/detect.mjs'),
  'export-unknown-words': () => import('./lib/dict/export-unknown-words.mjs'),
  'import-unknown-words': () => import('./lib/dict/import-unknown-words.mjs'),
  'export-pos-master': () => import('./lib/dict/export-pos-master.mjs'),
  'import-pos-master': () => import('./lib/dict/import-pos-master.mjs'),
  'export-user-dict': () => import('./lib/dict/export-user-dict.mjs'),
};

/**
 * `dict`サブコマンドの操作を振り分ける。
 *
 * @param {string[]} rest 操作名以降の引数
 */
async function runDict(rest = []) {
  const [operation, ...opArgs] = rest;
  if (!operation) {
    throw new UsageError(`操作を指定してください。ヘルプ: ${PROG} dict --help`);
  }
  if (!(operation in DICT_OPERATIONS)) {
    throw new UsageError(`不明な操作です: ${operation}。ヘルプ: ${PROG} dict --help`);
  }

  const load = DICT_OPERATIONS[operation];
  if (!load) {
    throw new Error(`dict ${operation}は#12の移行中です。現行スクリプトを使用してください。`);
  }

  const { run } = await load();
  return run(opArgs);
}

/**
 * DBを書き換えるサブコマンド(排他制御の対象)。
 */
const MUTATING_COMMANDS = new Set(['sync', 'update-embeddings', 'update-pagerank']);

/**
 * DBを書き換えるdict操作(排他制御の対象)。
 */
const MUTATING_DICT_OPERATIONS = new Set(['detect', 'import-unknown-words', 'import-pos-master']);

/**
 * 排他制御の対象(DBを書き換えるか)を判定する。
 *
 * @param {string} sub サブコマンド名
 * @param {string[]} rest サブコマンド以降の引数
 * @returns {boolean}
 */
function isMutating(sub, rest) {
  if (MUTATING_COMMANDS.has(sub)) return true;
  if (sub === 'dict') return MUTATING_DICT_OPERATIONS.has(rest[0]);
  return false;
}

/**
 * 未移行のサブコマンドを実行した場合の処理。
 */
function notMigrated(name) {
  throw new Error(`${name}は#12の移行中です。現行スクリプトを使用してください。`);
}

/**
 * サブコマンド一覧のヘルプを標準出力へ出す。
 */
function printHelp() {
  echo(`${PROG} - ナレッジベースCLI\n`);
  echo('使い方:');
  echo(`  ${PROG} <サブコマンド> [options]\n`);
  echo('サブコマンド:');
  for (const [name, def] of Object.entries(COMMANDS)) {
    echo(`  ${name.padEnd(20)} ${def.summary}`);
  }
  echo(`\nヘルプ: ${PROG} <サブコマンド> --help`);
}

/**
 * サブコマンド単体のヘルプを標準出力へ出す。
 *
 * @param {object} def サブコマンド定義
 */
function printCommandHelp(def) {
  echo(def.usage);
  echo('');
  echo(def.summary);
}

/**
 * CLIエントリポイント。exitコードは 0=成功 / 1=実行時エラー / 2=使い方・設定エラー。
 *
 * @returns {Promise<number>} 終了コード
 */
async function cli() {
  const [sub, ...rest] = argv._.map(String);
  const def = sub ? COMMANDS[sub] : null;

  try {
    if (argv.help || argv.h) {
      if (def) {
        printCommandHelp(def);
      } else {
        printHelp();
      }
      return 0;
    }

    if (!sub) {
      printHelp();
      throw new UsageError('サブコマンドを指定してください。');
    }

    if (!def) {
      throw new UsageError(`不明なサブコマンドです: ${sub}。ヘルプ: ${PROG} --help`);
    }

    // 依存パッケージはサブコマンドの読み込み時に必要になるため、実行前に確認する
    await ensureDependencies();

    // DBを書き換えるサブコマンドは排他制御する(review#6)
    const lockFile = isMutating(sub, rest) ? acquireLock() : null;
    try {
      await (def.run ? def.run(rest) : notMigrated(sub));
      return 0;
    } finally {
      if (lockFile) releaseLock(lockFile);
    }
  } catch (e) {
    if (e instanceof ConfigValidationError || e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    console.error(e?.message || String(e));
    return 1;
  }
}

process.exit(await cli());
