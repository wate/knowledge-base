/**
 * intfloat/multilingual-e5-small を使ったベクトル化モジュール
 *
 * モデルをメモリに保持し、複数回のembedding生成を効率的に行う。
 *
 * @module embed
 *
 * @usage
 * ```js
 * import { getEmbedding } from './lib/embed.mjs';
 * const vec = await getEmbedding('テキスト', 'passage'); // 384次元
 * const vec2 = await getEmbedding('クエリ', 'query');
 * ```
 */

import { pipeline } from '@huggingface/transformers';
import { loadConfig } from './config.mjs';

let pipe = null;

/**
 * pipeline のシングルトンインスタンスを取得する。
 *
 * @returns {Promise<Function>} feature-extraction パイプラインの関数
 */
async function getPipe() {
  if (!pipe) {
    const config = loadConfig();
    const cacheDir = path.resolve(process.cwd(), config.embedding.cache_dir);
    pipe = await pipeline(
      'feature-extraction',
      config.embedding.model,
      { cache_dir: cacheDir }
    );
  }
  return pipe;
}

/**
 * テキストをベクトル化する。
 *
 * @param {string} text 入力テキスト
 * @param {'passage'|'query'} prefix プレフィックス（登録用: passage, 検索用: query）
 * @returns {Promise<number[]>} 384次元のベクトル配列
 */
export async function getEmbedding(text, prefix = 'query') {
  const fn = await getPipe();
  const input = `${prefix}: ${text}`;
  const result = await fn(input, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}
