/**
 * @fileoverview anydocによる形式変換モジュール
 *
 * `@firecrawl/anydoc`でOffice文書・PDF・EPUBなどをMarkdownへ変換する。
 * ローカル完結で動作し、ホステッドOCR(`ocr: 'hosted'`)は使用しない。
 *
 * 抽出したMarkdownの加工は行わない(正規化は`lib/ingest.mjs`の取り込み時に実施する)。
 *
 * @example
 * ```javascript
 * import { extract } from './lib/extract/anydoc.mjs';
 * const markdown = await extract('/path/to/file.docx');
 * ```
 */

/**
 * ファイルをMarkdownへ変換する。
 *
 * @param {string} filePath 変換対象ファイルの絶対パス
 * @returns {Promise<string>} 変換されたMarkdown
 * @throws {Error} anydocの変換エラー。`error.code`に`needsOcr`・`encrypted`・`malformed`・`unsupported`等が入る
 */
export async function extract(filePath) {
  const { toMarkdown } = await import('@firecrawl/anydoc');
  return toMarkdown(filePath);
}
