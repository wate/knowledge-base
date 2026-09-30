/**
 * @fileoverview lib/embed.mjs の単体テスト
 *
 * embeddingモデルのロードと推論を伴うため、既定ではスキップする。
 * 実行する場合は環境変数`KB_TEST_EMBED=1`を指定する(モデルの取得にネットワークを使う場合がある)。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { getEmbedding } from '../lib/embed.mjs';

const SKIP = process.env.KB_TEST_EMBED
  ? false
  : 'KB_TEST_EMBED=1 を指定すると実行します(モデルのロードを伴うため)';

test('getEmbedding: 384次元のベクトルを返す', { skip: SKIP }, async () => {
  const vector = await getEmbedding('テスト用のテキスト');
  assert.equal(vector.length, 384);
});

test('getEmbedding: queryとpassageで入力が変わる', { skip: SKIP }, async () => {
  const query = await getEmbedding('テスト用のテキスト', 'query');
  const passage = await getEmbedding('テスト用のテキスト', 'passage');

  assert.equal(query.length, 384);
  assert.equal(passage.length, 384);
  assert.notDeepEqual(query, passage);
});
