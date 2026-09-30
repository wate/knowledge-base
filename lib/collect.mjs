// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview 単一ソースの収集と変換(collectの変換経路)
 *
 * ローカルファイル・Web URLを統一的に処理し、
 * Markdown + YAMLフロントマターの文字列を返す。
 *
 * 処理順:
 *   1. プラグインによる収集
 *   2. バイナリ形式の場合はanydocでMarkdown化
 *   3. HTMLのMarkdown化
 *   4. YAMLフロントマター生成
 *
 * 正規化は取り込み時(lib/ingest.mjs)にMDASTのtextノード単位で行う。
 *
 * パイプ連携と`-o`のファイル出力は設けない(`sync`が同一プロセスで受け取る)。
 */

/**
 * スキップして継続するanydocのエラーコード。
 *
 * これらは「ドキュメントを変換できない」ことを示すため、
 * ファイル単位でスキップし、他のファイルの処理を続ける。
 *
 * @type {Set<string>}
 */
const SKIPPABLE_ANYDOC_CODES = new Set([
  'needsOcr',
  'encrypted',
  'malformed',
  'unsupported',
]);

/**
 * 単一のソースを収集→変換し、フロントマター付きMarkdownを返す。
 *
 * @param {string} spec 取得先(ファイルパスまたはURL)
 * @param {object} [options] オプション
 * @param {string|null} [options.sourceType=null] ソース種別の明示指定(--source相当)
 * @returns {Promise<string>} フロントマター付きMarkdown
 */
export async function collectToMarkdown(spec, { sourceType = null } = {}) {
  const { detectSource, loadPlugin } = await import('./source/registry.mjs');
  const cliOptions = sourceType ? { type: sourceType } : {};
  const { type: detectedType, sourceSpec: resolvedSpec, options: pluginOptions } =
    detectSource(spec, cliOptions);

  console.error(chalk.cyan(`  🔍 ソース検出: ${detectedType} > ${resolvedSpec}`));

  // localの場合は存在確認のみ行う(ディレクトリ展開はsync側の責務)
  if (detectedType === 'local') {
    const absPath = path.resolve(resolvedSpec);
    if (!fs.existsSync(absPath)) {
      throw new Error(`パスが見つかりません: ${absPath}`);
    }
    if (fs.statSync(absPath).isDirectory()) {
      throw new Error(`collectはディレクトリを処理できません: ${absPath}`);
    }
  }

  const plugin = await loadPlugin(detectedType);
  if (!plugin) {
    throw new Error(`未対応のソース種別: ${detectedType}`);
  }

  // ---- ① 収集 ----
  console.error(chalk.cyan(`  📦 収集中: ${resolvedSpec}`));
  const collected = await plugin.collect(resolvedSpec, pluginOptions);

  // ---- ② Markdown化: バイナリ形式はanydocで変換 ----
  let rawText = collected.content;
  const title = collected.title;

  if (collected.rawFilePath) {
    // バイナリ形式: extract registry 経由でMarkdown化する
    const { getExtractor } = await import('./extract/registry.mjs');
    const ext = path.extname(collected.rawFilePath).toLowerCase();
    const extractFn = await getExtractor(ext);

    if (extractFn) {
      console.error(chalk.cyan(`  🔄 ${ext.toUpperCase()}変換: ${resolvedSpec}`));
      try {
        rawText = await extractFn(collected.rawFilePath);
      } catch (err) {
        // 変換できないファイルはスキップ理由としてエラーコードを伝える(中断はしない)
        const code = err?.code;
        if (code && SKIPPABLE_ANYDOC_CODES.has(code)) {
          const skipError = new Error(err.message);
          skipError.name = code;
          throw skipError;
        }
        throw err;
      }
    }
  }

  // ---- ③ Markdown化 ----
  let markdown = '';
  const sourceTypeName = collected.sourceType;

  if (sourceTypeName === 'html') {
    // HTML: unified変換
    console.error(chalk.cyan(`  🔄 HTML変換: ${resolvedSpec}`));
    try {
      const { unified } = await import('unified');
      const rehypeParse = (await import('rehype-parse')).default;
      const rehypeRemark = (await import('rehype-remark')).default;
      const remarkStringify = (await import('remark-stringify')).default;
      const remarkGfmMod = await import('remark-gfm');
      const remarkGfm = remarkGfmMod.default || remarkGfmMod;
      const file = await unified()
        .use(rehypeParse, { fragment: true })
        .use(rehypeRemark)
        .use(remarkGfm)
        .use(remarkStringify, { bullet: '-', listItemIndent: 'one', tightDefinitions: true })
        .process(rawText);
      markdown = String(file);
    } catch (err) {
      console.error(chalk.yellow(`  ⚠ HTML変換エラー: ${err.message}`));
      markdown = rawText;
    }
  } else {
    // Markdown / その他: 素通し
    markdown = rawText;
  }

  // 変換結果が空の場合は登録しない(review#37)
  if (!markdown.trim()) {
    throw new Error('変換結果が空のため登録をスキップします');
  }

  // ---- ④ YAMLフロントマター生成 ----
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
  const sources = collected.sourceMeta
    ? [{ ...collected.sourceMeta, fetched: now }]
    : [{ url: resolvedSpec, source_type: detectedType, fetched: now }];

  const frontmatter = { title, sources };
  const fmYaml = YAML.stringify(frontmatter);
  const result = `---\n${fmYaml}---\n\n${markdown}`;

  console.error(chalk.green(`  ✅ 変換完了: ${(markdown.length / 1024).toFixed(1)} KB`));

  return result;
}
