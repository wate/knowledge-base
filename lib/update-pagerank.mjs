// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview ドキュメント間リンクを抽出し、PageRankを計算して
 * documents.pagerank_scoreを更新する。
 *
 * `sync`の後に、必要に応じて手動実行する。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs update-pagerank               # docs/ を対象にリンク解析→PageRank計算
 * knowledge-base.mjs update-pagerank docs          # 対象ディレクトリを指定
 * knowledge-base.mjs update-pagerank docs knowledge-base/external/cakephp  # 複数ディレクトリを対象
 * ```
 *
 * 処理フロー:
 *   1. Markdownファイル間のリンクを抽出
 *   2. ファイルパスをdocuments.idに解決 → doc_linksに一括投入
 *   3. doc_linksからPageRankを計算
 *   4. pagerank_scoreをバッチUPDATE
 */

import pkg from 'graphology';
const { Graph } = pkg;
import pkgPr from 'graphology-pagerank';
const pagerank = pkgPr.default || pkgPr;

import { query, exec } from './db.mjs';
import { loadConfig } from './config.mjs';

const config = loadConfig();

// ---- 以下3関数は md-links から移植 (リンク抽出のコアロジック) ----

/**
 * Markdownテキストからリンクを抽出する。
 *
 * @param {string} markdown 解析対象のMarkdownテキスト
 * @returns {string[]} 抽出されたリンクURL配列
 */
function extractLinks(markdown) {
  const normalized = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
  const linkRegex = /!?\[.*?\]\((.*?)\)/g;
  const links = [];
  let match;
  while ((match = linkRegex.exec(normalized)) !== null) {
    links.push(match[1]);
  }
  return links;
}

/**
 * リンクURLを正規化する(アンカー・クエリ除去)。
 *
 * @param {string} link 正規化対象のリンクURL
 * @returns {string} パス部分のみ
 */
function normalizeLink(link) {
  return link.split('#')[0].split('?')[0];
}

/**
 * 外部リンクかどうかを判定する。
 *
 * @param {string} link 判定対象のリンクURL
 * @returns {boolean}
 */
function isExternalLink(link) {
  return link.startsWith('http://') || link.startsWith('https://') || link.startsWith('mailto:');
}

/**
 * Markdownファイル間リンクを抽出する。
 *
 * @param {string} srcDir 解析対象ディレクトリの絶対パス
 * @returns {Promise<Object<string, {links: string[]}>>}
 */
async function extractMarkdownLinks(srcDir) {
  // 除外パターン: CLI引数 > config > デフォルト
  const excludePatterns = argv.exclude
    ? (Array.isArray(argv.exclude) ? argv.exclude : [argv.exclude])
    : (config.source_local?.exclude_patterns || ['node_modules/**', '.git/**', 'vendor/**']);
  const ignorePatterns = excludePatterns.map((p) => {
    const dir = p.replace('/**', '').replace('**/', '');
    return `${dir}/**/*.md`;
  });
  const mdFiles = await glob('**/*.md', {
    cwd: srcDir,
    absolute: true,
    ignore: ignorePatterns,
  });
  mdFiles.sort();
  const result = {};

  // ループ不変値: スコープ解決の基準を事前に計算
  const linkScope = argv.scope || 'src';
  const projectRoot = process.cwd();
  const scopeBase = linkScope === 'project' ? projectRoot : srcDir;

  for (const file of mdFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rawLinks = extractLinks(content);
    const links = [];

    for (const raw of rawLinks) {
      const link = normalizeLink(raw);
      if (!link || isExternalLink(link)) continue;

      const resolved = path.resolve(path.dirname(file), link);
      if (resolved.startsWith(scopeBase) && resolved.endsWith('.md') && fs.existsSync(resolved)) {
        links.push(path.relative(srcDir, resolved));
      }
    }

    // 同一ファイル内の重複リンクを除去
    const uniqueLinks = [...new Set(links)];

    if (uniqueLinks.length > 0) {
      result[path.relative(srcDir, file)] = { links: uniqueLinks };
    }
  }

  return result;
}

/**
 * ファイルパスからdocuments.idを解決する。
 *
 * @param {string} filePath ドキュメントのファイルパス
 * @returns {Promise<number|null>} ドキュメントID、見つからない場合はnull
 */
async function resolveDocId(filePath) {
  const rows = await query(
    'SELECT id FROM documents WHERE file_path = $1',
    [filePath]
  );
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * メイン処理。
 *
 * ドキュメント間リンクを抽出し、PageRankを計算して
 * documents.pagerank_scoreを更新する。
 *
 * @param {string[]} rest 対象ディレクトリ(複数指定可。省略時はdocs)
 */
export async function run(rest = []) {
  const srcDirs = (rest.length > 0 ? rest : ['docs']).map((dir) => path.resolve(dir));

  echo(chalk.bold('\n📊 PageRank 更新\n'));

  // ----------------------------------------
  // Step 1: リンク抽出(内部処理。md-links依存排除)
  // リンクの解決範囲はソースディレクトリ単位に閉じる
  // ----------------------------------------
  // キーはdocuments.file_pathと同じ絶対パス
  const linkData = new Map();
  for (const absSrc of srcDirs) {
    // 設定のsourcesにはxlsx等のファイルも並ぶため、ディレクトリ以外は解析しない
    if (!fs.existsSync(absSrc) || !fs.statSync(absSrc).isDirectory()) {
      echo(chalk.gray(`  ⏭ リンク解析の対象外(ディレクトリではない): ${absSrc}`));
      continue;
    }
    echo(chalk.cyan(`  🔗 リンク解析: ${absSrc}`));
    const perDir = await extractMarkdownLinks(absSrc);
    for (const [fromPath, info] of Object.entries(perDir)) {
      linkData.set(path.resolve(absSrc, fromPath), {
        links: info.links.map((link) => path.resolve(absSrc, link)),
      });
    }
    echo(chalk.gray(`    解析完了: ${Object.keys(perDir).length} ファイル`));
  }
  echo('');

  // ----------------------------------------
  // Step 2: doc_links をクリアして再投入
  // ----------------------------------------
  echo(chalk.cyan('  🗑  doc_links をクリア...'));
  await exec('DELETE FROM doc_links;');

  // 全INSERTを収集して一括実行(バッチ書き込み)
  const linkStmts = [];
  let skipped = 0;

  for (const [fromPath, info] of linkData) {
    const sourceId = await resolveDocId(fromPath);
    if (!sourceId) { skipped++; continue; }

    for (const toPath of info.links) {
      const targetId = await resolveDocId(toPath);
      if (!targetId) { skipped++; continue; }

      linkStmts.push(
        `INSERT OR IGNORE INTO doc_links (source_doc_id, target_doc_id, anchor_text) VALUES (${sourceId}, ${targetId}, '');\n`
      );
    }
  }

  await exec(linkStmts.join(''));
  echo(chalk.green(`  ✅ ${linkStmts.length} リンクを登録しました`));
  if (skipped > 0) echo(chalk.yellow(`  ⚠ ${skipped} はID解決不可でスキップ`));

  const linkCount = await query('SELECT COUNT(*) AS cnt FROM doc_links');
  const linkCountNum = Number(linkCount[0]?.cnt ?? 0);
  echo(chalk.gray(`  doc_links 総件数: ${linkCountNum}\n`));

  if (linkStmts.length === 0) {
    echo(chalk.yellow('  ⚠ リンクが登録されませんでした。PageRank計算をスキップします\n'));
    return;
  }

  // ----------------------------------------
  // Step 3: PageRank計算
  // ----------------------------------------
  echo(chalk.cyan('  📊 PageRank計算中...'));

  const edges = await query('SELECT source_doc_id, target_doc_id FROM doc_links');
  const allDocs = await query('SELECT id FROM documents');
  echo(chalk.gray(`    ノード: ${allDocs.length}, エッジ: ${edges.length}`));

  if (allDocs.length === 0) {
    echo(chalk.yellow('  ⚠ documents が空です\n'));
    return;
  }

  // グラフ構築
  const graph = new Graph({ multi: false, type: 'directed' });
  for (const doc of allDocs) graph.addNode(String(doc.id));

  let addedEdges = 0;
  let skippedEdges = 0;
  for (const e of edges) {
    const s = String(e.source_doc_id);
    const t = String(e.target_doc_id);
    if (!graph.hasEdge(s, t)) {
      try {
        graph.addEdge(s, t);
        addedEdges++;
      } catch {
        // 自己ループや多重エッジはPageRank計算に影響しないため、件数のみ記録する
        skippedEdges++;
      }
    }
  }
  if (skippedEdges > 0) {
    echo(chalk.yellow(`  ⚠ ${skippedEdges} 件のエッジをスキップしました(自己ループ等)`));
  }

  // PageRank計算
  const scores = pagerank(graph, { damping: 0.85, maxIterations: 100, tolerance: 1e-6 });
  echo(chalk.gray('    計算完了\n'));

  // ----------------------------------------
  // Step 4: バッチ書き込み
  // ----------------------------------------
  echo(chalk.cyan('  💾 スコアを書き込み中...'));
  const batchStmts = [];
  for (const [nodeId, score] of Object.entries(scores)) {
    batchStmts.push(`UPDATE documents SET pagerank_score = ${score} WHERE id = ${nodeId};\n`);
  }
  await exec(batchStmts.join(''));
  echo(chalk.green(`  ✅ ${batchStmts.length}件のスコアを更新しました\n`));

  // ----------------------------------------
  // Step 5: 結果表示
  // ----------------------------------------
  const results = await query(
    `SELECT id, file_path, ROUND(pagerank_score::DOUBLE, 6) AS pr FROM documents ORDER BY pr DESC LIMIT 10`
  );

  echo(chalk.bold('  上位10件:\n'));
  for (const r of results) {
    echo(chalk.cyan(`    ${r.pr}  ${r.file_path}`));
  }
  echo('');
}
