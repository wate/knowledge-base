// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview ナレッジベース検索(BM25 / ベクトル / ハイブリッド)
 *
 * @usage
 * ```sh
 * knowledge-base.mjs search <クエリ>              # BM25検索(既定)
 * knowledge-base.mjs search --vector <クエリ>     # ベクトル検索
 * knowledge-base.mjs search --hybrid <クエリ>     # ハイブリッド検索
 * knowledge-base.mjs search --top 5 <クエリ>      # 上位5件に絞る
 * knowledge-base.mjs search --json <クエリ>       # JSON出力(AI連携用)
 * knowledge-base.mjs search -j <クエリ>           # 短縮形
 * ```
 */

import { getEmbedding } from './embed.mjs';
import { query } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadLindera, createTokenizer, tokenizeToWakati } from './lindera.mjs';
import { UsageError } from './errors.mjs';

const config = loadConfig();
const DICT_DIR = config.dictionary.system_dir;
const DICT_TYPE = config.dictionary.type;
const USER_DICT_PATH = config.dictionary.user_dict;

// Lindera Tokenizer の遅延初期化
let linderaTokenizer = null;
async function ensureTokenizer() {
  if (linderaTokenizer) return;
  const lindera = loadLindera();
  const userDictPath = fs.existsSync(USER_DICT_PATH) ? USER_DICT_PATH : null;
  linderaTokenizer = await createTokenizer(lindera, DICT_DIR, userDictPath, DICT_TYPE);
}
const WEIGHTS = config.search.weights;
const HYBRID_WEIGHTS = config.search.hybrid_weights;
const HEADING_W = config.heading_weights;
const TOP_N = config.search.top_n_documents;

/**
 * Lindera でテキストを分かち書きする。
 *
 * lib/lindera.mjs の Tokenizer モジュールを使用する。
 * 初回呼び出し時に Tokenizer を遅延初期化する。
 *
 * @param {string} text 入力テキスト
 * @returns {Promise<string>} スペース区切りの分かち書き結果
 */
async function tokenize(text) {
  if (!text?.trim()) return '';
  await ensureTokenizer();
  return tokenizeToWakati(linderaTokenizer, text);
}

/**
 * BM25全文検索を実行する。
 *
 * @param {string} wakati 分かち書き済みの検索クエリ
 * @param {number} limit 取得件数
 * @returns {Promise<object[]>} 検索結果の配列
 */
async function searchBM25(wakati, limit) {
  const e = wakati.replace(/'/g, "''");
  return query(`
    SELECT sq.id, sq.document_id, sq.heading, sq.chunk_index, sq.level,
      ROUND(sq.score::DOUBLE, 4) AS score,
      SUBSTRING(sq.content, 1, 200) AS preview, d.file_path, s.url AS source_url
    FROM (SELECT c.*, fts_main_chapters.match_bm25(c.id, '${e}') AS score FROM chapters c) sq
    LEFT JOIN documents d ON d.id = sq.document_id
    LEFT JOIN sources s ON s.document_id = d.id AND s.source_type = 'ref'
    WHERE sq.score IS NOT NULL ORDER BY sq.score DESC LIMIT ${limit}`);
}

/**
 * ベクトル類似度検索を実行する。
 *
 * cosine類似度(候補全体のmin-max正規化) + PageRank(同) + 見出し重み + 位置重み の複合スコアでソートする。
 *
 * @param {number[]} queryEmb クエリのembeddingベクトル
 * @param {number} limit 取得件数
 * @returns {Promise<object[]>} 検索結果の配列
 */
async function searchVector(queryEmb, limit) {
  const e = `[${queryEmb.join(',')}]`;
  return query(`
    SELECT c.id, c.document_id, c.heading, c.chunk_index, c.level,
      ROUND(list_cosine_similarity(c.embedding, ${e}::FLOAT[384])::DOUBLE, 4) AS similarity,
      ROUND(d.pagerank_score::DOUBLE, 6) AS pagerank,
      ROUND(
        ${WEIGHTS.cosine} * COALESCE((list_cosine_similarity(c.embedding, ${e}::FLOAT[384])::DOUBLE - cos_stats.min_cos) / NULLIF(cos_stats.max_cos - cos_stats.min_cos, 0), 0)
        + ${WEIGHTS.pagerank} * COALESCE((d.pagerank_score - pr_stats.min_pr) / NULLIF(pr_stats.max_pr - pr_stats.min_pr, 0), 0)
        + ${WEIGHTS.heading} * CASE c.level ${Object.entries(HEADING_W).map(([k, v]) => `WHEN ${k} THEN ${v}`).join(' ')} ELSE 0 END / 9.0
        + ${WEIGHTS.position} * (1.0 / (c.chunk_index + 1))::DOUBLE,
        4
      ) AS score,
      SUBSTRING(c.content, 1, 200) AS preview, d.file_path, s.url AS source_url
    FROM chapters c
    LEFT JOIN documents d ON d.id = c.document_id
    LEFT JOIN sources s ON s.document_id = d.id AND s.source_type = 'ref'
    LEFT JOIN (SELECT MIN(pagerank_score) AS min_pr, MAX(pagerank_score) AS max_pr FROM documents) pr_stats ON 1=1
    LEFT JOIN (SELECT MIN(cos) AS min_cos, MAX(cos) AS max_cos FROM (SELECT list_cosine_similarity(embedding, ${e}::FLOAT[384])::DOUBLE AS cos FROM chapters WHERE embedding IS NOT NULL)) cos_stats ON 1=1
    WHERE c.embedding IS NOT NULL
    ORDER BY score DESC LIMIT ${limit}`);
}

/**
 * ハイブリッド検索(ベクトル + BM25)を実行する。
 *
 * まずベクトル類似度で上位`search.top_n_documents`件の文書を絞り込み、その範囲で
 * BM25スコアとベクトルスコアを加重組み合わせする。
 *
 * @param {number[]} queryEmb クエリのembeddingベクトル
 * @param {string} queryWakati 分かち書き済みの検索クエリ
 * @param {number} limit 取得件数
 * @returns {Promise<object[]>} 検索結果の配列
 */
async function searchHybrid(queryEmb, queryWakati, limit) {
  const e = `[${queryEmb.join(',')}]`;
  const ew = queryWakati.replace(/'/g, "''");
  const topN = await query(
    `SELECT id FROM documents WHERE embedding IS NOT NULL ORDER BY list_cosine_similarity(embedding, ${e}::FLOAT[384]) DESC LIMIT ${TOP_N}`);
  const ids = topN.map(r => r.id);
  if (!ids.length) return [];
  const idList = ids.join(',');

  return query(`
    WITH pr_stats AS (
      SELECT MIN(pagerank_score) AS min_pr, MAX(pagerank_score) AS max_pr FROM documents
    ),
    cos_stats AS (
      SELECT MIN(list_cosine_similarity(embedding, ${e}::FLOAT[384])::DOUBLE) AS min_cos,
             MAX(list_cosine_similarity(embedding, ${e}::FLOAT[384])::DOUBLE) AS max_cos
      FROM chapters WHERE document_id IN (${idList}) AND embedding IS NOT NULL
    ),
    vec AS (
      SELECT c.id, c.document_id, c.heading, c.chunk_index, c.level, c.content,
        ROUND(list_cosine_similarity(c.embedding, ${e}::FLOAT[384])::DOUBLE, 4) AS similarity,
        ROUND(${WEIGHTS.cosine} * COALESCE((list_cosine_similarity(c.embedding, ${e}::FLOAT[384])::DOUBLE - cos_stats.min_cos) / NULLIF(cos_stats.max_cos - cos_stats.min_cos, 0), 0)
          + ${WEIGHTS.pagerank} * COALESCE((COALESCE(d.pagerank_score, 1.0) - pr_stats.min_pr) / NULLIF(pr_stats.max_pr - pr_stats.min_pr, 0), 0)
          + ${WEIGHTS.heading} * CASE c.level ${Object.entries(HEADING_W).map(([k, v]) => `WHEN ${k} THEN ${v}`).join(' ')} ELSE 0 END / 9.0
          + ${WEIGHTS.position} * (1.0 / (c.chunk_index + 1))::DOUBLE, 4) AS vec_score
      FROM chapters c
      JOIN documents d ON d.id = c.document_id
      CROSS JOIN pr_stats
      CROSS JOIN cos_stats
      WHERE c.document_id IN (${idList}) AND c.embedding IS NOT NULL
    ), bm AS (
      SELECT v.id, fts_main_chapters.match_bm25(v.id, '${ew}') AS bm_score
      FROM vec v
    )
    SELECT v.id, v.document_id, v.heading, v.chunk_index, v.level,
      v.vec_score, bm.bm_score,
      ROUND(
        ${HYBRID_WEIGHTS.vector} * v.vec_score
        + ${HYBRID_WEIGHTS.bm25} * COALESCE(bm.bm_score, 0), 4
      ) AS score,
      SUBSTRING(v.content, 1, 200) AS preview, d.file_path, s.url AS source_url
    FROM vec v
    LEFT JOIN bm ON bm.id = v.id
    LEFT JOIN documents d ON d.id = v.document_id
    LEFT JOIN sources s ON s.document_id = d.id AND s.source_type = 'ref'
    ORDER BY score DESC LIMIT ${limit}`);
}

/**
 * メイン処理。
 *
 * サブコマンドの引数に応じてBM25 / ベクトル / ハイブリッド検索を実行し、
 * 結果を表示する。
 *
 * @param {string[]} rest クエリ文字列(空白区切りで連結する)
 */
export async function run(rest = []) {
  const mode = argv.vector ? 'vector' : argv.hybrid ? 'hybrid' : 'bm25';
  const limit = Math.min(Math.max(parseInt(argv.top || argv.n || 20, 10) || 20, 1), 100);
  const jsonMode = argv.json || argv.j || false;

  // --json 時は進捗メッセージを stderr に出力(stdout は pure JSON に保つ)
  const log = jsonMode ? console.error : echo;

  // zxのargv解析では --vector "クエリ" が argv.vector = "クエリ" になる
  const query = rest.join(' ') || (typeof argv.vector === 'string' ? argv.vector : '') || (typeof argv.hybrid === 'string' ? argv.hybrid : '');
  if (!query) {
    throw new UsageError('使い方: knowledge-base.mjs search [--vector|--hybrid] [--top N] <クエリ>');
  }
  log(chalk.bold(`\n🔍 [${mode.toUpperCase()}] ${query}\n`));
  // ベクトル検索は辞書を使わないため分かち書きしない(Tokenizer生成で辞書を取得しない)
  const wakati = mode === 'vector' ? '' : await tokenize(query);
  if (wakati) log(chalk.gray(`    Lindera: ${wakati}\n`));

  let results;
  if (mode === 'bm25') results = await searchBM25(wakati, limit);
  else {
    log(chalk.gray('    embedding生成中...'));
    const qe = await getEmbedding(query, 'query');
    results = mode === 'vector' ? await searchVector(qe, limit) : await searchHybrid(qe, wakati, limit);
  }
  if (!results?.length) { log(chalk.yellow('  該当なし')); return; }

  // --json フラグが指定された場合はJSON出力(AIによる利用を想定)
  if (jsonMode) {
    echo(JSON.stringify(results, null, 2));
    return;
  }

  const tag = { bm25: 'BM25', vector: 'VEC', hybrid: 'HYB' }[mode];
  echo(chalk.bold(`📊 ${results.length} 件\n`));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];

    const h = r.heading || '(見出しなし)';
    const p = (r.preview || '').replace(/\n/g, ' ').substring(0, 100);
    const sc = r.bm_score != null ? `V:${r.vec_score} BM:${r.bm_score}` : `${r.score || r.similarity}`;
    echo(chalk.cyan(`  ${i+1}. [${tag} ${sc}] ${h}`));
    if (r.file_path) echo(chalk.gray(`       ${r.file_path}`));
    if (r.source_url) echo(chalk.gray(`       📎 ${r.source_url}`));
    echo(chalk.gray(`       ${p}${p.length>=100?'...':''}\n`));
  }
}
