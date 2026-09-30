/**
 * @fileoverview lib/normalize.mjs の単体テスト
 *
 * 7つの正規化ルールと、MDASTのtextノード限定の挙動を検証する。
 * 辞書とネットワークを必要としない。
 * テストはzx経由(`npm test`)で実行する。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { normalizeText, normalizeTree } from '../lib/normalize.mjs';

test('normalizeText: 制御文字を除去する', () => {
    assert.equal(normalizeText('a\x00b\x07c\x7Fd'), 'abcd');
});

test('normalizeText: ゼロ幅文字と特殊スペースを除去する', () => {
    assert.equal(normalizeText('a\u200Bb\uFEFFc\u00ADd'), 'abcd');
});

test('normalizeText: 日本語文字間のスペースを除去する', () => {
    assert.equal(normalizeText('プロンプティ ング'), 'プロンプティング');
});

test('normalizeText: 連続する3つ以上のスペースを1つに圧縮する', () => {
    assert.equal(normalizeText('a   b'), 'a b');
});

test('normalizeText: 句読点・括弧の前後のスペースを除去する', () => {
    assert.equal(normalizeText('これは 、テスト（ 例 ）です'), 'これは、テスト(例)です');
});

test('normalizeText: 全角英数字を半角へ変換する', () => {
    assert.equal(normalizeText('ＡＢＣ１２３'), 'ABC123');
});

test('normalizeText: 約物を統一する', () => {
    assert.equal(normalizeText('インターフェース•仕様'), 'インターフェース・仕様');
});

test('normalizeText: カタカナ後の記号を長音へ変換する', () => {
    assert.equal(normalizeText('コンピュータ−５'), 'コンピューター5');
});

test('normalizeText: 数値のマイナスは保持する', () => {
    assert.equal(normalizeText('5−3'), '5−3');
});

test('normalizeText: 空文字は空文字のまま返す', () => {
    assert.equal(normalizeText(''), '');
});

test('normalizeTree: textノードだけを正規化し、コードは変更しない', async () => {
    const { remark } = await import('remark');
    const { visit } = await import('unist-util-visit');

    const markdown = ['ＡＢＣ１２３', '', '`ＡＢＣ`', '', '```', 'ＡＢＣ', '```', ''].join('\n');
    const tree = remark().parse(markdown);
    normalizeTree(tree);

    const nodes = [];
    visit(tree, ['text', 'inlineCode', 'code'], (node) => nodes.push(`${node.type}:${node.value}`));

    assert.deepEqual(nodes, ['text:ABC123', 'inlineCode:ＡＢＣ', 'code:ＡＢＣ']);
});
