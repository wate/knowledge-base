// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview 取り込み経路の統合(sync)
 *
 * 設定(`.knowledge-base.yml`)または指定ソースを解決し、
 * 差分のあったファイルだけを「収集→変換→正規化→DB登録」まで1プロセスで処理する。
 * 全ファイルの処理後にFTSインデックスを1回だけ再作成し、
 * embedding生成とPageRank更新を続けて実行する。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs sync                     # 全ソース取り込み＋差分更新
 * knowledge-base.mjs sync <src>               # 指定ソースのみ処理
 * knowledge-base.mjs sync --full              # 全ソースフル再取り込み
 * knowledge-base.mjs sync --dry-run           # 変換結果を標準出力(DB登録なし)
 * knowledge-base.mjs sync --local-only        # ローカルソースのみ処理
 * knowledge-base.mjs sync --skip-embed        # embedding生成をスキップ
 * knowledge-base.mjs sync --skip-pagerank     # PageRank更新をスキップ
 * knowledge-base.mjs sync --limit 5           # 各ソース先頭5件のみ
 * knowledge-base.mjs sync --config custom.yml # 設定ファイルを指定
 * ```
 */

import { resolveMapping } from './source/mapping.mjs';
import { query, execute, exec } from './db.mjs';
import { loadConfig } from './config.mjs';
import picomatch from 'picomatch';
import { collectToMarkdown } from './collect.mjs';
import { ingestMarkdown, rebuildFtsIndex } from './ingest.mjs';

// ---- DB操作ヘルパー ----

/**
 * DBのdocumentsテーブルから全ローカルファイルの file_path → modified マップを読み込む。
 *
 * @returns {Promise<Map<string, string>>}
 */
async function loadDbFileMap() {
  const rows = await query(
    `SELECT file_path, CAST(modified AS VARCHAR) AS modified FROM documents WHERE file_path NOT LIKE 'http%'`,
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.file_path, row.modified || '');
  }
  return map;
}

/**
 * FSファイルのmtimeをDBのmodifiedと同じ文字列形式で返す。
 *
 * @param {string} file 絶対ファイルパス
 * @returns {string|null} 文字列形式のmtime、取得失敗時はnull
 */
function getMtimeStr(file) {
  try {
    const stat = fs.statSync(file);
    return stat.mtime.toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
  } catch (e) {
    echo(chalk.yellow(`  ⚠ 更新日時の取得に失敗しました: ${file} (${e.message})`));
    return null;
  }
}

// ---- ファイル解決 ----

async function resolveSourceFiles(spec) {
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    return [spec];
  }

  const absPath = path.resolve(process.cwd(), spec);
  if (!fs.existsSync(absPath)) {
    echo(chalk.yellow(`  ⚠ パスが見つかりません: ${absPath}`));
    return [];
  }

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    const { expandDirectory } = await import('./source/local.mjs');
    // expandDirectory()は対応拡張子のみを返すため、ここで再度絞り込まない
    return expandDirectory(absPath);
  }

  return [absPath];
}

/**
 * FSファイル一覧をDBレコードと突き合わせ、差分を計算する。
 *
 * @param {string[]} fsFiles FS上のファイル絶対パス一覧
 * @param {Map<string, string>} dbMap DBの file_path → modified マップ
 * @returns {{ newFiles: string[], updatedFiles: string[], deletedFiles: string[] }}
 */
function computeDiff(fsFiles, dbMap) {
  const newFiles = [];
  const updatedFiles = [];

  for (const file of fsFiles) {
    const dbMtime = dbMap.get(file);
    if (dbMtime === undefined) {
      newFiles.push(file);
      continue;
    }

    // DBに存在する → mtime比較
    dbMap.delete(file); // マッチしたので削除候補から除外
    const fsMtime = getMtimeStr(file);
    if (fsMtime !== null && dbMtime !== fsMtime) {
      updatedFiles.push(file);
    }
    // mtime一致 → 変更なし、何もしない
  }

  // dbMapに残ったエントリ → DBにあってFSにない(削除候補)
  const deletedFiles = [...dbMap.keys()].filter(fp => !fp.startsWith('http'));

  return { newFiles, updatedFiles, deletedFiles };
}

/**
 * DBから孤立レコード(DBに存在するがFSにないファイル)を削除する。
 *
 * @param {string[]} filePaths 削除対象のfile_path一覧
 */
async function deleteOrphans(filePaths) {
  if (filePaths.length === 0) return;

  echo(chalk.yellow(`  🗑 ${filePaths.length} ファイルをDBから削除`));
  for (const filePath of filePaths) {
    await exec('BEGIN TRANSACTION');
    try {
      await execute('DELETE FROM sources WHERE document_id = (SELECT id FROM documents WHERE file_path = $1)', [filePath]);
      await execute('DELETE FROM chapters WHERE document_id = (SELECT id FROM documents WHERE file_path = $1)', [filePath]);
      await execute('DELETE FROM documents WHERE file_path = $1', [filePath]);
      await exec('COMMIT');
    } catch (e) {
      await exec('ROLLBACK');
      echo(chalk.red(`  ❌ 削除エラー: ${e.message}`));
      continue;
    }
    echo(chalk.gray(`    🗑 ${path.basename(filePath)}`));
  }
}

// ---- メイン処理 ----

/**
 * メイン処理。
 *
 * @param {string[]} rest 単一ソース指定(省略時は設定のsourcesを使う)
 */
export async function run(rest = []) {
  const cliConfigFile = argv.config || argv.c || null;
  const config = loadConfig({ configFile: cliConfigFile });

  // --config 指定時はその旨を表示
  if (cliConfigFile) {
    echo(chalk.gray(`  --config: ${cliConfigFile}`));
  }
  const sources = rest[0] ? [rest[0]] : (config.sources || []);
  const localOnly = argv['local-only'] || argv.localOnly;
  const full = argv.full;
  const dryRun = argv['dry-run'] || argv.dryRun;
  const skipEmbed = argv['skip-embed'] || argv.skipEmbed;
  const skipPagerank = argv['skip-pagerank'] || argv.skipPagerank;
  const limit = parseInt(argv.limit || argv.l || 0, 10) || 0;

  echo(chalk.bold(`\n📦 ナレッジベース 一括処理 (${sources.length} ソース)`));
  if (full) echo(chalk.gray('  --full: 全件再取り込み'));
  if (dryRun) echo(chalk.gray('  --dry-run: 変換結果を出力(DB登録なし)'));
  if (localOnly) echo(chalk.gray('  --local-only: ローカルソースのみ'));
  if (skipEmbed) echo(chalk.gray('  --skip-embed: embedding生成をスキップ'));
  if (skipPagerank) echo(chalk.gray('  --skip-pagerank: PageRank更新をスキップ'));
  if (limit > 0) echo(chalk.gray(`  --limit ${limit}`));
  echo('');

  let totalFiles = 0;
  let totalSkipped = 0;
  let failedFiles = 0;

  // DB上のローカルファイルマップを事前読み込み(--full でも孤立判定に使う)
  const dbMap = await loadDbFileMap();
  // computeDiff でマッチしたエントリをここに追加(孤立レコード判定用)
  const matchedPaths = new Set();

  for (const entry of sources) {
    const sourceSpec = typeof entry === 'string' ? entry : (entry.source || entry.path || '');
    if (localOnly && (sourceSpec.startsWith('http://') || sourceSpec.startsWith('https://'))) {
      echo(chalk.gray(`  ⏭ Web (--local-only): ${sourceSpec}`));
      continue;
    }

    let files = await resolveSourceFiles(sourceSpec);
    if (files.length === 0) {
      echo(chalk.yellow(`  ⚠ 対象ファイルなし: ${sourceSpec}`));
      continue;
    }

    // ソース単位の除外パターン
    // 単一ソース指定(sync <src>)でも設定エントリの指定を適用する
    const configEntry = rest[0]
      ? (config.sources || []).find((e) => {
        if (typeof e !== 'object' || e === null) return false;
        const spec = e.source || e.path || '';
        return path.resolve(process.cwd(), spec) === path.resolve(process.cwd(), sourceSpec);
      })
      : entry;
    const sourceExcludePatterns = Array.isArray(configEntry?.exclude_patterns)
      ? configEntry.exclude_patterns
      : [];

    // exclude_patterns にマッチするファイルを除外
    const allExcludePatterns = [
      ...(config.source_local?.exclude_patterns || []),
      ...sourceExcludePatterns,
    ];
    if (allExcludePatterns.length > 0) {
      const relPaths = files.map(f => path.relative(process.cwd(), f));
      const filtered = files.filter((f, i) => {
        for (const pattern of allExcludePatterns) {
          if (picomatch(pattern, { dot: true })(relPaths[i])) return false;
        }
        return true;
      });
      const excluded = files.length - filtered.length;
      if (excluded > 0) {
        echo(chalk.gray(`  🚫 除外パターンに一致: ${excluded} ファイル`));
      }
      files = filtered;
    }

    // 差分検出(Webソースと --full は全件処理)
    const isWeb = sourceSpec.startsWith('http://') || sourceSpec.startsWith('https://');
    let targets;
    let newCount = 0;
    let updatedCount = 0;

    // ソースディレクトリ配下のDBエントリ(孤立判定にも使う)
    const sourceDir = path.resolve(process.cwd(), sourceSpec);
    const sourceDbPaths = [...dbMap.keys()].filter(
      (fp) => fp.startsWith(sourceDir + path.sep) || fp === sourceDir,
    );

    if (full || isWeb) {
      targets = limit > 0 ? files.slice(0, limit) : files;
    } else {
      // computeDiff は localDbMap を破壊的に編集(マッチしたエントリは削除される)
      const localDbMap = new Map(sourceDbPaths.map((fp) => [fp, dbMap.get(fp)]));
      const diff = computeDiff(files, localDbMap);
      targets = limit > 0
        ? [...diff.newFiles, ...diff.updatedFiles].slice(0, limit)
        : [...diff.newFiles, ...diff.updatedFiles];
      newCount = diff.newFiles.length;
      updatedCount = diff.updatedFiles.length;
      totalSkipped += files.length - targets.length;

      // マッチしたFSファイルを記録(孤立判定用)
      for (const f of files) {
        if (dbMap.has(f)) matchedPaths.add(f);
      }
    }

    // 孤立削除(DBにあってFSにないファイル)。--full でも実行する
    if (!dryRun && !isWeb) {
      const fsSet = new Set(files);
      const deletedFiles = sourceDbPaths.filter((fp) => !fsSet.has(fp));
      if (deletedFiles.length > 0) {
        await deleteOrphans(deletedFiles);
        // dbMap からも削除して孤立判定から除外
        for (const df of deletedFiles) {
          dbMap.delete(df);
          matchedPaths.add(df);
        }
      }
    }

    const diffNote = (full || isWeb)
      ? ` (${targets.length}/${files.length} 件)`
      : ` (新規 ${newCount} / 更新 ${updatedCount} 件、スキップ ${files.length - targets.length})`;

    echo(chalk.cyan(`  📥 ${sourceSpec}${diffNote}`));

    for (const file of targets) {
      // source_mappings を解決し、原本URLがあれば ingest へ渡す
      const mapping = resolveMapping(file, config.source_mappings, process.cwd());
      const prevExtra = process.env.EXTRA_SOURCES;
      if (mapping) {
        process.env.EXTRA_SOURCES = JSON.stringify([{ url: mapping.url, source_type: mapping.source_type }]);
      }

      try {
        const markdown = await collectToMarkdown(file);
        if (dryRun) {
          process.stdout.write(`===== ${file} =====\n${markdown}\n`);
          continue;
        }
        await ingestMarkdown(markdown, file);
        echo(chalk.gray(`    ✅ ${path.relative(process.cwd(), file)}`));
        totalFiles++;
      } catch (e) {
        // 一括系は継続し、スキップ件数と理由(エラー種別)を集計する
        failedFiles++;
        echo(chalk.yellow(`  ⚠ スキップ(${e.name || 'Error'}): ${file}: ${e.message?.split('\n')[0] || e}`));
      } finally {
        if (mapping) {
          if (prevExtra === undefined) {
            delete process.env.EXTRA_SOURCES;
          } else {
            process.env.EXTRA_SOURCES = prevExtra;
          }
        }
      }
    }
  }

  // 全ソース処理後、どのソースにも属さない孤立レコードを削除
  // 単一ソース指定(rest[0])のときは、他ソースのレコードを削除しない
  if (!full && !dryRun && !rest[0]) {
    const remainingOrphans = [...dbMap.keys()].filter(
      fp => !fp.startsWith('http') && !matchedPaths.has(fp),
    );
    if (remainingOrphans.length > 0) {
      await deleteOrphans(remainingOrphans);
    }
  }

  if (dryRun) {
    echo(chalk.bold('\n✨ 変換結果を出力しました(--dry-run。DB登録はしていません)'));
    return;
  }

  const failedNote = failedFiles > 0 ? `、${failedFiles} ファイル失敗` : '';
  echo(chalk.bold(`\n✨ 取り込み完了 (${totalFiles} ファイル登録、${totalSkipped} ファイルスキップ${failedNote})`));

  // FTS再構築は全ファイルの処理後に1回だけ行う
  if (totalFiles > 0) {
    echo(chalk.cyan('\n🔍 FTSインデックスを再作成中...'));
    await rebuildFtsIndex();
    echo(chalk.green('✅ FTSインデックス再作成完了\n'));
  }

  if (!skipEmbed) {
    echo(chalk.cyan('\n🧠 embedding 生成...'));
    const { run: runEmbeddings } = await import('./update-embeddings.mjs');
    await runEmbeddings([], { limit: 0 });
    echo(chalk.green('✅ embedding 生成完了'));

    // 生成漏れの残存を検知する(生成に失敗した文書があると0件にならない)
    const [{ count: remaining }] = await query(
      'SELECT count(*) AS count FROM documents WHERE embedding IS NULL',
    );
    if (remaining > 0) {
      echo(chalk.yellow(`  ⚠ 埋め込み未生成の文書が ${remaining} 件残っています`));
    }
  }

  // PageRank更新(リンク解析の対象は設定のローカルソース)
  if (!skipPagerank) {
    const pagerankDirs = sources
      .map((entry) => (typeof entry === 'string' ? entry : (entry.source || entry.path || '')))
      .filter((spec) => spec && !spec.startsWith('http://') && !spec.startsWith('https://'));

    if (pagerankDirs.length === 0) {
      echo(chalk.gray('\n📊 PageRank更新: ローカルソースが無いためスキップ'));
    } else {
      echo(chalk.cyan('\n📊 PageRank更新...'));
      try {
        const { run: runPagerank } = await import('./update-pagerank.mjs');
        await runPagerank(pagerankDirs);
        echo(chalk.green('✅ PageRank更新完了'));
      } catch (e) {
        echo(chalk.yellow(`  ⚠ PageRank更新スキップ: ${e.message?.split('\n')[0] || e}`));
      }
    }
  }
}
