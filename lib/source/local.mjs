/**
 * @fileoverview ローカルファイル/ディレクトリ source plugin
 *
 * ローカルファイルシステムからデータを収集する。
 * - 単一ファイル: 内容を読み取り、メタデータを抽出
 * - ディレクトリ: expandDirectory() でファイル一覧を取得し、
 *   `lib/collect.mjs` が1ファイルずつ collect() を呼び出す
 *
 * @example
 * ```javascript
 * import { collect, expandDirectory } from './lib/source/local.mjs';
 *
 * // 単一ファイル
 * const result = await collect('/path/to/file.md');
 *
 * // ディレクトリのファイル一覧
 * const files = await expandDirectory('/path/to/dir');
 * for (const f of files) {
 *   const result = await collect(f);
 * }
 * ```
 */

/**
 * 収集対象の拡張子(exclude registryより動的に取得)
 */
const { getSupportedExts, TEXT_EXTS } = await import('../extract/registry.mjs');
const TARGET_EXTS = getSupportedExts();

/**
 * ローカルファイルからデータを収集する。
 *
 * @param {string} filePath 収集対象のファイルパス
 * @param {object} [options={}] オプション
 * @returns {Promise<{ content: string, title: string, sourceType: string, sourceMeta: object, rawFilePath: string|null }>}
 */
export async function collect(filePath, options = {}) {
  const fs = await import('fs');
  const path = await import('path');
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`ファイルが見つかりません: ${absPath}`);
  }

  const ext = path.extname(absPath).toLowerCase();
  const fileName = path.basename(absPath, ext);
  const sourceType = ext.replace(/^\./, '');

  // ファイル読み取り
  let content = fs.readFileSync(absPath, 'utf8');
  let title = fileName;

  // タイトル解決(anydocはタイトル相当を返さないため、バイナリ形式はファイル名を使う)
  if (ext === '.md' || ext === '.markdown') {
    title = resolveFrontmatterTitle(content, fileName);
  } else if (ext === '.html' || ext === '.htm') {
    title = resolveHtmlTitle(content, fileName);
  }

  return {
    content,
    title,
    sourceType,
    sourceMeta: {
      path: absPath,
      source_type: 'local_file',
    },
    rawFilePath: TEXT_EXTS.includes(ext) ? null : absPath,
  };
}

/**
 * ディレクトリ内の収集対象ファイルを再帰的にリストする。
 *
 * @param {string} dirPath スキャンするディレクトリパス
 * @param {object} [options={}] オプション
 * @param {string[]} [options.excludes] 除外するディレクトリ名の一覧(優先)。
 *   指定がない場合はデフォルトの除外リストを使用
 * @returns {Promise<string[]>} 対象ファイルの絶対パス一覧
 */
export async function expandDirectory(dirPath, options = {}) {
  const fs = await import('fs');
  const path = await import('path');
  const absPath = path.resolve(dirPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`ディレクトリが見つかりません: ${absPath}`);
  }

  // 除外ディレクトリ名を解決（オプション優先 → デフォルト）
  const excludes = options.excludes || [
    'node_modules', '.git', 'vendor', '.svn', '.hg',
  ];

  const results = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (excludes.includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (TARGET_EXTS.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(absPath);
  return results;
}

/**
 * Markdownのフロントマターからタイトルを取得する。
 *
 * @param {string} content Markdown内容
 * @param {string} fallback フォールバックのタイトル
 * @returns {string}
 */
function resolveFrontmatterTitle(content, fallback) {
  try {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (match) {
      // titleのみ簡易パース。YAMLライブラリに依存しない
      const titleLine = match[1].split('\n').find((l) => /^title\s*:/.test(l));
      if (titleLine) {
        const val = titleLine.replace(/^title\s*:\s*/, '').replace(/["']/g, '').trim();
        if (val) return val;
      }
    }
  } catch { /* 解析失敗時はフォールバックを使う(意図的) */ }
  return fallback;
}

/**
 * HTMLのタイトルタグからタイトルを取得する。
 *
 * @param {string} content HTML内容
 * @param {string} fallback フォールバックのタイトル
 * @returns {string}
 */
function resolveHtmlTitle(content, fallback) {
  const match = content.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (match && match[1].trim()) return match[1].trim();
  return fallback;
}
