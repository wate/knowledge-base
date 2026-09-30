/**
 * @fileoverview 拡張子↔extractor のマッピング管理
 *
 * バイナリ形式(pdf等)のextractorのみを登録する。
 * テキスト形式(md, html, txt)はレジストリに載せず、`lib/collect.mjs`側で素通し処理する。
 *
 * @example
 * ```javascript
 * import { getExtractor } from './lib/extract/registry.mjs';
 * const extractFn = getExtractor('.pdf');
 * if (extractFn) {
 *   const text = await extractFn('/path/to/file.pdf');
 * }
 * ```
 */

/**
 * テキスト形式（素通し）の拡張子一覧。
 *
 * これらの拡張子はextractorを介さず、
 * そのまま文字列として扱う。
 *
 * @type {string[]}
 */
const TEXT_EXTS = ['.md', '.markdown', '.html', '.htm', '.txt'];

/**
 * 拡張子からextractorモジュールのパスへのマッピング。
 *
 * バイナリ形式(Office文書・PDF等)のみ登録する。
 * テキスト形式はTEXT_EXTSで管理する。
 * 対象はanydocの対応形式から`.csv`と`.pot`を除いた19種とする。
 *
 * @type {Object<string, string>}
 */
const REGISTRY = {
  '.doc': './anydoc.mjs',
  '.docx': './anydoc.mjs',
  '.docm': './anydoc.mjs',
  '.ppt': './anydoc.mjs',
  '.pps': './anydoc.mjs',
  '.pptx': './anydoc.mjs',
  '.pptm': './anydoc.mjs',
  '.ppsx': './anydoc.mjs',
  '.ppsm': './anydoc.mjs',
  '.xls': './anydoc.mjs',
  '.xlsx': './anydoc.mjs',
  '.xlsm': './anydoc.mjs',
  '.xlsb': './anydoc.mjs',
  '.odt': './anydoc.mjs',
  '.ods': './anydoc.mjs',
  '.odp': './anydoc.mjs',
  '.rtf': './anydoc.mjs',
  '.epub': './anydoc.mjs',
  '.pdf': './anydoc.mjs',
};

/**
 * 拡張子に対応するextractor関数を取得する。
 *
 * @param {string} ext 拡張子（.pdf, .docx 等）
 * @returns {Promise<Function|null>} extract(filePath) 関数。未登録の場合は null
 */
export async function getExtractor(ext) {
  const modulePath = REGISTRY[ext.toLowerCase()];
  if (!modulePath) return null;

  try {
    const mod = await import(modulePath);
    return mod.extract || null;
  } catch {
    return null;
  }
}

/**
 * 対応する全拡張子の一覧を取得する（binary + text）
 *
 * @returns {string[]} 拡張子の配列（'.pdf', '.md', '.txt' ...）
 */
export function getSupportedExts() {
  return [...Object.keys(REGISTRY), ...TEXT_EXTS];
}

export { REGISTRY, TEXT_EXTS };
