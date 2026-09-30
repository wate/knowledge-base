/**
 * @fileoverview lib/lindera.mjs の単体テスト
 *
 * 辞書バイナリを必要としない判定ロジックのみを検証する。
 * テストはzx経由(`npm test`)で実行する。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ensureDictionary, isDictionaryConsistent, tokenizeToWakati } from '../lib/lindera.mjs';

test('isDictionaryConsistent: nameが一致する場合はtrueを返す', () => {
  const dictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dict-check-'));
  fs.writeFileSync(path.join(dictDir, 'metadata.json'), JSON.stringify({ name: 'ipadic-neologd' }));

  assert.equal(isDictionaryConsistent(dictDir, 'ipadic-neologd'), true);
  fs.rmSync(dictDir, { recursive: true, force: true });
});

test('isDictionaryConsistent: nameが不一致の場合はfalseを返す', () => {
  const dictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dict-check-'));
  fs.writeFileSync(path.join(dictDir, 'metadata.json'), JSON.stringify({ name: 'ipadic' }));

  assert.equal(isDictionaryConsistent(dictDir, 'ipadic-neologd'), false);
  fs.rmSync(dictDir, { recursive: true, force: true });
});

test('isDictionaryConsistent: metadata.jsonが無い場合はfalseを返す', () => {
  const dictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dict-check-'));

  assert.equal(isDictionaryConsistent(dictDir, 'ipadic-neologd'), false);
  fs.rmSync(dictDir, { recursive: true, force: true });
});

test('isDictionaryConsistent: metadata.jsonが読めない場合はfalseを返す', () => {
  const dictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dict-check-'));
  fs.writeFileSync(path.join(dictDir, 'metadata.json'), 'not json');

  assert.equal(isDictionaryConsistent(dictDir, 'ipadic-neologd'), false);
  fs.rmSync(dictDir, { recursive: true, force: true });
});

test('tokenizeToWakati: 空文字と空白のみの場合は空文字を返す', () => {
  const tokenizer = {
    tokenize: () => {
      throw new Error('空入力ではトークナイズしない');
    },
  };
  assert.equal(tokenizeToWakati(tokenizer, ''), '');
  assert.equal(tokenizeToWakati(tokenizer, '   '), '');
});

test('tokenizeToWakati: トークンの表層形をスペース区切りで連結する', () => {
  const tokenizer = {
    tokenize: () => [{ surface: '形態素' }, { surface: '解析' }],
  };
  assert.equal(tokenizeToWakati(tokenizer, '形態素解析'), '形態素 解析');
});

test('tokenizeToWakati: トークナイズ失敗時は原文を返す', () => {
  const tokenizer = {
    tokenize: () => {
      throw new Error('トークナイズ失敗');
    },
  };
  assert.equal(tokenizeToWakati(tokenizer, '原文テキスト'), '原文テキスト');
});

test('ensureDictionary: nameが一致する場合は再取得しない', async () => {
  const dictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dict-'));
  const metadataPath = path.join(dictDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify({ name: 'ipadic-neologd' }));
  const before = fs.readdirSync(dictDir).sort();
  const beforeMtime = fs.statSync(metadataPath).mtimeMs;

  // 一致する場合は何もしない(ダウンロードが起きるとネットワーク接続が必要になる)
  await ensureDictionary(dictDir, 'ipadic-neologd');

  assert.deepEqual(fs.readdirSync(dictDir).sort(), before);
  assert.equal(fs.statSync(metadataPath).mtimeMs, beforeMtime);
  fs.rmSync(dictDir, { recursive: true, force: true });
});
