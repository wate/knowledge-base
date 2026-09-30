/**
 * @fileoverview lib/ingest.mjs の文書要約生成の単体テスト
 *
 * 見出しが無い文書でも埋め込みの入力が空にならないことを検証する。
 * DB接続は不要。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildDocumentSummary } from '../lib/ingest.mjs';

test('buildDocumentSummary: 見出しがある場合は見出しtreeをそのまま返す', () => {
  const headingTree = '# 見出し1\n## 見出し2';

  assert.equal(buildDocumentSummary(headingTree, '本文の段落'), headingTree);
});

test('buildDocumentSummary: 見出しが無い場合は本文の先頭段落を返す', () => {
  const content = '最初の段落\n\n2つ目の段落';

  assert.equal(buildDocumentSummary('', content), '最初の段落');
});
