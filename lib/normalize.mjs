/**
 * @fileoverview 取り込み時のテキスト正規化
 *
 * MarkdownのMDASTを走査し、`text`ノードの値だけを正規化する。
 * インラインコード・コードブロック・URLは対象外とする。
 *
 * 旧パイプライン機構の3スクリプト(`normalize-text`・`normalize-halfwidth`・
 * `normalize-punctuation`)の有効なルールだけを1パスへ統合したもの。
 * 行頭・行末のトリムと連続空行の圧縮はシリアライザの責務のため実装しない。
 *
 * @example
 * ```javascript
 * import { normalizeTree } from './lib/normalize.mjs';
 * const tree = remark().use(remarkGfm).parse(body);
 * normalizeTree(tree);
 * ```
 */

const { visit } = await import('unist-util-visit');

/**
 * 全角英数字・記号の半角変換テーブル。
 *
 * 全角スペース(`　`)は半角スペースへ変換する。
 *
 * @type {Object<string, string>}
 */
const FULLWIDTH_MAP = {
    'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E',
    'Ｆ': 'F', 'Ｇ': 'G', 'Ｈ': 'H', 'Ｉ': 'I', 'Ｊ': 'J',
    'Ｋ': 'K', 'Ｌ': 'L', 'Ｍ': 'M', 'Ｎ': 'N', 'Ｏ': 'O',
    'Ｐ': 'P', 'Ｑ': 'Q', 'Ｒ': 'R', 'Ｓ': 'S', 'Ｔ': 'T',
    'Ｕ': 'U', 'Ｖ': 'V', 'Ｗ': 'W', 'Ｘ': 'X', 'Ｙ': 'Y',
    'Ｚ': 'Z',
    'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd', 'ｅ': 'e',
    'ｆ': 'f', 'ｇ': 'g', 'ｈ': 'h', 'ｉ': 'i', 'ｊ': 'j',
    'ｋ': 'k', 'ｌ': 'l', 'ｍ': 'm', 'ｎ': 'n', 'ｏ': 'o',
    'ｐ': 'p', 'ｑ': 'q', 'ｒ': 'r', 'ｓ': 's', 'ｔ': 't',
    'ｕ': 'u', 'ｖ': 'v', 'ｗ': 'w', 'ｘ': 'x', 'ｙ': 'y',
    'ｚ': 'z',
    '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
    '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
    '！': '!', '＂': '"', '＃': '#', '＄': '$', '％': '%',
    '＆': '&', '＇': "'", '（': '(', '）': ')', '＊': '*',
    '＋': '+', '，': ',', '－': '-', '．': '.', '／': '/',
    '：': ':', '；': ';', '＜': '<', '＝': '=', '＞': '>',
    '？': '?', '＠': '@', '［': '[', '＼': '\\', '］': ']',
    '＾': '^', '＿': '_', '｀': '`', '｛': '{', '｜': '|',
    '｝': '}', '～': '~', '　': ' ',
};

/**
 * テキストを正規化する。
 *
 * @param {string} text 正規化前の文字列
 * @returns {string} 正規化後の文字列
 */
export function normalizeText(text) {
    if (!text) return '';

    let t = text;

    // 1. 制御文字の除去(改行・タブ以外)
    t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // 2. ゼロ幅文字・特殊スペース・書式制御文字の除去
    t = t.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, '');

    // 3. 日本語文字間のスペース削除
    t = t.replace(/([ぁ-んァ-ヴー一-龥])[ 　](?=[ぁ-んァ-ヴー一-龥])/g, '$1');
    t = t.replace(/([ぁ-んァ-ヴー一-龥])[ 　](?=[a-zA-Z])/g, '$1 ');
    t = t.replace(/([a-zA-Z])[ 　](?=[ぁ-んァ-ヴー一-龥])/g, '$1 ');

    // 4. 連続する3つ以上のスペースの圧縮
    t = t.replace(/[ 　]{3,}/g, ' ');

    // 5. 日本語句読点・括弧の前後のスペース削除
    t = t.replace(/[ 　]*([、。．，！？）】〕」』］])/g, '$1');
    t = t.replace(/([（【「『［])[ 　]*/g, '$1');

    // 6. 全角英数字・記号の半角化
    t = t.replace(/[Ａ-Ｚａ-ｚ０-９！-～　]/g, (ch) => FULLWIDTH_MAP[ch] || ch);

    // 7. 約物の統一
    t = t.replace(/[•･]/g, '・');
    t = t.replace(/([ァ-ヴ])[−–—―]/g, '$1ー');
    t = t.replace(/[〝〟＂]/g, '"');
    t = t.replace(/[“‘]/g, "'");
    t = t.replace(/\.{3,}/g, '…');
    t = t.replace(/…{2,}/g, '…');

    return t;
}

/**
 * MDASTの`text`ノードだけを正規化する。
 *
 * ツリーを直接書き換える。インラインコード・コードブロック・URLは対象外。
 *
 * @param {object} tree MDASTルートノード
 * @returns {object} 正規化後のツリー(引数と同じ参照)
 */
export function normalizeTree(tree) {
    visit(tree, 'text', (node) => {
        node.value = normalizeText(node.value);
    });
    return tree;
}
