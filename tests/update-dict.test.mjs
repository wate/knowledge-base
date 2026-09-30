/**
 * @fileoverview ユーザー辞書ビルドの実行判定の単体テスト
 *
 * `dict export-user-dict`は出力対象が0件のときCSVを出力しない。
 * `update-dict`はその状態で`lindera build`を呼ぶと失敗するため、
 * CSVの有無でビルドをスキップするかを判定する。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decideBuildAction } from '../lib/update-dict.mjs';

test('decideBuildAction: CSVが存在すればbuild', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-update-dict-'));
  const csvPath = path.join(dir, 'user-dict.csv');
  fs.writeFileSync(csvPath, '表層形,品詞,読み\nテスト語,カスタム名詞,テストゴ\n');

  try {
    assert.equal(decideBuildAction(csvPath), 'build');
  } finally {
    await fs.remove(dir);
  }
});

test('decideBuildAction: CSVが無ければskip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-update-dict-'));
  const csvPath = path.join(dir, 'user-dict.csv');

  try {
    assert.equal(decideBuildAction(csvPath), 'skip');
  } finally {
    await fs.remove(dir);
  }
});
