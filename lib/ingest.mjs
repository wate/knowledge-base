// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview Markdownファイルをナレッジベースに取り込むモジュール
 *
 * Markdownファイルを remark MDAST でパースし、見出し階層に応じて
 * 章(chapter)単位に分割したうえで、DuckDBのナレッジベースに登録します。
 * 各チャプターの本文はLinderaで分かち書きされ、FTS検索に利用されます。
 *
 * このモジュールは `lib/sync.mjs` から呼び出される内部モジュールで、
 * 通常は `knowledge-base.mjs sync` 経由で実行する。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs sync <file.md>   # 指定ファイルのみ取り込み
 * knowledge-base.mjs sync             # 設定の全ソースを取り込み
 * ```
 *
 * @example
 * ```sh
 * knowledge-base.mjs sync docs/index.md
 * knowledge-base.mjs sync .ticket/task/knowledge-base/document-search-design.md
 * ```
 *
 * 対応DB: knowledge-base.duckdb
 */

// ----------------------------------------
// 依存関係の確認
// ----------------------------------------

// 依存パッケージの確認と自動インストールは lib/ensure-deps.mjs に集約している
import { ensureDependencies } from './ensure-deps.mjs';

// ----------------------------------------
// モジュールのインポート
// ----------------------------------------

const remarkMod = await import('remark');
const { remark } = remarkMod.default || remarkMod;
const remarkGfmMod = await import('remark-gfm');
const remarkGfm = remarkGfmMod.default || remarkGfmMod;
const unistUtilVisitMod = await import('unist-util-visit');
const { visit } = unistUtilVisitMod.default || unistUtilVisitMod;

// ----------------------------------------
// モジュールのインポート
// ----------------------------------------

import { loadLindera, createTokenizer } from './lindera.mjs';
import { loadConfig } from './config.mjs';
import { query, execute, exec } from './db.mjs';
import { normalizeTree } from './normalize.mjs';

// ----------------------------------------
// 設定
// ----------------------------------------

const config = loadConfig();
const DICT_DIR = config.dictionary.system_dir;
const DICT_TYPE = config.dictionary.type;
const USER_DICT_PATH = config.dictionary.user_dict;
const HEADING_WEIGHTS = config.heading_weights;

// embeddingモジュールの動的インポート（モデルロードは初回のみ）
let embedLib = null;

/**
 * embedding モジュールを動的にインポートする（シングルトン）。
 *
 * モデルのロードは初回呼び出し時のみ行われ、2回目以降はキャッシュを返す。
 *
 * @returns {Promise<typeof import('./lib/embed.mjs')>} embed モジュール
 */
async function getEmbedLib() {
  if (!embedLib) {
    embedLib = await import('./embed.mjs');
  }
  return embedLib;
}

// Linderaバインディングの遅延初期化（ユーザー辞書が存在すれば読み込む）
let linderaTokenizer = null;

/**
 * Lindera Tokenizer を遅延初期化する（シングルトン）。
 *
 * 初回呼び出し時に loadLindera() + createTokenizer() を実行する。
 * ユーザー辞書が存在すれば自動的に読み込む。
 *
 * @returns {Promise<void>}
 */
async function ensureLindera() {
  if (linderaTokenizer) return;
  const lindera = loadLindera();
  const userDictPath = fs.existsSync(USER_DICT_PATH) ? USER_DICT_PATH : null;
  linderaTokenizer = await createTokenizer(lindera, DICT_DIR, userDictPath, DICT_TYPE);
}

/**
 * Linderaバインディングで分かち書きを実行する。
 *
 * 初回呼び出し時に Tokenizer を遅延初期化する。
 * ユーザー辞書が存在する場合は自動的に読み込む。
 *
 * @param {string} text 分かち書き対象のテキスト
 * @returns {Promise<string>} スペース区切りの分かち書き結果
 */
async function tokenizeWithLindera(text) {
  if (!text || text.trim().length === 0) return '';
  await ensureLindera();
  try {
    const tokens = linderaTokenizer.tokenize(text);
    return tokens.map((t) => t.surface).join(' ');
  } catch (e) {
    echo(chalk.yellow(`  ⚠ トークナイズに失敗したため原文を使用します: ${e.message}`));
    return text;
  }
}

// ----------------------------------------
// ユーティリティ
// ----------------------------------------

/**
 * MDASTツリーから見出し階層を抽出し、章単位のチャンクを生成する。
 *
 * 分割点は「`minLevel`以下の深さを持ち、かつ本文ノードを持つ見出し」に限る。
 * 分割点にしない見出しのうち配下に章を持つものは、そのテキストを子章の見出しへ
 * `親 / 子`の形式で前置する(見出し一致による検索順位を保つため)。
 * 残りの分割点にしない見出しのテキストは、所属する章の本文へ含める。
 * 分割点が1件も無い場合はファイル全体を1チャンクとして扱う。
 *
 * @param {object} tree MDASTルートノード
 * @param {number} [minLevel=3] 分割点に使う最も深い見出しレベル
 * @returns {Array<{heading: string|null, level: number|null, content: string, chunk_index: number}>} チャンクの配列
 */
function extractChapters(tree, minLevel = 3) {
  const allChildren = tree.children;
  const headings = [];

  // 全見出しノードを収集する(本文の有無は後で判定する)
  visit(tree, 'heading', (node) => {
    const index = allChildren.indexOf(node);
    if (index === -1) return; // 入れ子の見出しは分割点の候補にしない
    const text = node.children
      .filter((c) => c.type === 'text' || c.type === 'inlineCode')
      .map((c) => c.value)
      .join('');
    headings.push({
      level: node.depth,
      text,
      index,
    });
  });

  // レベル上限を満たし、直後の見出しとの間に本文テキストを持つ見出しだけを分割点にする
  // 生HTMLのコメントのように本文へ復元できないノードしか無い場合は分割点にしない
  const splitPoints = headings.filter((heading, i) => {
    if (heading.level > minLevel) return false;
    const next = headings[i + 1];
    const end = next ? next.index : allChildren.length;
    return allChildren
      .slice(heading.index + 1, end)
      .some((n) => n.type !== 'heading' && extractNodeMarkdown(n).trim() !== '');
  });

  if (splitPoints.length === 0) {
    // 見出しが無い、または本文を持つ見出しが無い場合はファイル全体を1チャンクとして扱う
    const text = extractTextContent(tree);
    return [{ heading: null, level: null, content: text, chunk_index: 0 }];
  }

  // 分割点にしない祖先見出しを、子章の見出しへ前置するパンくずとして集める
  const splitIndexes = new Set(splitPoints.map((h) => h.index));
  const breadcrumbs = new Map();
  const ancestors = [];
  for (const heading of headings) {
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= heading.level) {
      ancestors.pop();
    }
    if (splitIndexes.has(heading.index)) {
      breadcrumbs.set(
        heading.index,
        ancestors.filter((a) => !splitIndexes.has(a.index)).map((a) => a.text),
      );
    }
    ancestors.push(heading);
  }

  const chapters = [];

  for (let i = 0; i < splitPoints.length; i++) {
    const heading = splitPoints[i];
    const end = i + 1 < splitPoints.length ? splitPoints[i + 1].index : allChildren.length;

    // 先頭の分割点より前のノードは最初の章へ含める(見出しはパンくずと重複するため除く)
    const leading = i === 0
      ? allChildren.slice(0, heading.index).filter((n) => n.type !== 'heading')
      : [];
    const sectionNodes = [...leading, ...allChildren.slice(heading.index + 1, end)];
    const content = sectionNodes.map((n) => extractNodeMarkdown(n)).join('\n\n').trim();

    const breadcrumb = breadcrumbs.get(heading.index) || [];
    chapters.push({
      heading: [...breadcrumb, heading.text].join(' / '),
      level: heading.level,
      content: content || '',
      chunk_index: i,
    });
  }

  return chapters;
}

/**
 * MDASTノードから簡易Markdownテキストを復元する。
 *
 * paragraph, heading, text, inlineCode, strong, emphasis, code, list,
 * table, thematicBreak, blockquote, link, image, yaml の各ノード型をサポートする。
 *
 * @param {object} node MDASTノード
 * @returns {string} Markdownテキスト
 */
function extractNodeMarkdown(node) {
  if (!node) return '';

  switch (node.type) {
    case 'paragraph':
      return node.children.map((c) => extractNodeMarkdown(c)).join('');
    case 'heading':
      return `${'#'.repeat(node.depth)} ${node.children.map((c) => extractNodeMarkdown(c)).join('')}`;
    case 'text':
      return node.value;
    case 'inlineCode':
      return `\`${node.value}\``;
    case 'strong':
      return `**${node.children.map((c) => extractNodeMarkdown(c)).join('')}**`;
    case 'emphasis':
      return `*${node.children.map((c) => extractNodeMarkdown(c)).join('')}*`;
    case 'code':
      return node.lang ? `\`\`\`${node.lang}\n${node.value}\n\`\`\`` : `\`\`\`\n${node.value}\n\`\`\``;
    case 'list': {
      const items = node.children.map((item) => {
        const text = item.children.map((c) => extractNodeMarkdown(c)).join('');
        return `- ${text}`;
      });
      return items.join('\n');
    }
    case 'listItem':
      return node.children.map((c) => extractNodeMarkdown(c)).join('');
    case 'table': {
      // 簡易テーブル復元
      const rows = node.children.map((row) => {
        const cells = row.children.map((cell) =>
          cell.children.map((c) => extractNodeMarkdown(c)).join(''),
        );
        return `| ${cells.join(' | ')} |`;
      });
      // セパレータ行を追加
      if (rows.length > 0) {
        const colCount = node.children[0]?.children.length || 1;
        const sep = `| ${Array(colCount).fill('---').join(' | ')} |`;
        rows.splice(1, 0, sep);
      }
      return rows.join('\n');
    }
    case 'thematicBreak':
      return '---';
    case 'blockquote':
      return `> ${node.children.map((c) => extractNodeMarkdown(c)).join('\n> ')}`;
    case 'link':
      return `[${node.children.map((c) => extractNodeMarkdown(c)).join('')}](${node.url})`;
    case 'image':
      return `![${node.alt || ''}](${node.url})`;
    case 'yaml':
      // frontmatterは無視
      return '';
    default:
      if (node.children) {
        return node.children.map((c) => extractNodeMarkdown(c)).join('');
      }
      return '';
  }
}

/**
 * MDASTツリー全体からテキストコンテンツを抽出する（見出しなしファイル用）。
 *
 * YAMLフロントマターノードは除外する。
 *
 * @param {object} tree MDASTルートノード
 * @returns {string} 抽出された全文テキスト
 */
function extractTextContent(tree) {
  return tree.children
    .filter((n) => n.type !== 'yaml')
    .map((n) => extractNodeMarkdown(n))
    .join('\n\n')
    .trim();
}

/**
 * embedding を生成する（embed-lib.mjs を直接利用）。
 *
 * @param {string} text ベクトル化対象テキスト
 * @param {'passage'|'query'} prefix プレフィックス（登録用: passage, 検索用: query）
 * @returns {Promise<number[]|null>} 384次元ベクトル。エラー時は null
 */
async function generateEmbedding(text, prefix = 'passage') {
  if (!text || text.trim().length === 0) return null;
  try {
    const lib = await getEmbedLib();
    return await lib.getEmbedding(text, prefix);
  } catch (e) {
    echo(chalk.red(`     embeddingエラー: ${e.message}`));
    return null;
  }
}

/**
 * MDASTツリーから見出しtree（擬似要約）を生成する。
 *
 * 設計書の生成例に合わせ、levelに応じた # のみを使用し、
 * インデントは付けない。
 *
 * @param {object} tree MDASTルートノード
 * @returns {string} 見出しtreeテキスト（Markdown形式）
 */
function generateHeadingTree(tree) {
  const lines = [];
  visit(tree, 'heading', (node) => {
    const text = node.children
      .filter((c) => c.type === 'text' || c.type === 'inlineCode')
      .map((c) => c.value)
      .join('');
    lines.push(`${'#'.repeat(node.depth)} ${text}`);
  });
  return lines.join('\n');
}

/**
 * 文書の要約（embeddingの入力）を組み立てる。
 *
 * 見出しtreeを優先し、見出しが無い場合は本文の先頭段落を使う。
 * 章の要約（getChapterSummary）と規則を揃える。
 *
 * @param {string} headingTree 見出しtreeテキスト
 * @param {string} content 本文全文
 * @returns {string} 文書の要約
 */
export function buildDocumentSummary(headingTree, content) {
  return headingTree || extractFirstParagraph(content);
}

/**
 * 本文の最初の非空段落を返す。
 *
 * @param {string} content Markdown本文
 * @returns {string} 最初の非空段落。該当が無い場合は空文字
 */
function extractFirstParagraph(content) {
  return content.split('\n\n').find((p) => p.trim().length > 0) || '';
}

/**
 * 章の擬似要約を生成する（見出し + 最初の段落）。
 *
 * 設計書の生成例に合わせ、実際の見出しレベルを使用する。
 *
 * @param {string|null} heading 見出しテキスト
 * @param {number|null} level 見出しレベル（1〜6、なしの場合はNULL）
 * @param {string} content 章コンテンツ
 * @returns {string} 擬似要約のMarkdownテキスト
 */
function getChapterSummary(heading, level, content) {
  const firstPara = extractFirstParagraph(content);
  if (heading && level) {
    return `${'#'.repeat(level)} ${heading}\n\n${firstPara}`;
  } else if (heading) {
    return `## ${heading}\n\n${firstPara}`;
  }
  return firstPara;
}

/**
 * MarkdownテキストからYAMLフロントマターを抽出してパースする。
 *
 * remark単体ではYAMLフロントマターを認識しないため、
 * パース前に手動で抽出する。
 *
 * @param {string} raw Markdown原文
 * @returns {{ body: string, frontmatter: object }} フロントマター除去後の本文とパース結果
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { body: raw, frontmatter: {} };
  try {
    const fm = YAML.parse(match[1]) || {};
    return { body: raw.slice(match[0].length), frontmatter: fm };
  } catch (e) {
    echo(chalk.yellow(`  ⚠ フロントマターの解析に失敗しました: ${e.message}`));
    return { body: raw, frontmatter: {} };
  }
}

// ----------------------------------------
// DB操作
// ----------------------------------------

/**
 * Markdownテキストをパースし、ナレッジベースに取り込む共通処理。
 *
 * 既存の同名ドキュメントがあれば削除してからINSERTする（冪等性確保）。
 * 全処理をトランザクションで保護し、エラー時はロールバックする。
 * パラメタライズドクエリ（$1, $2形式）を使用し、SQLインジェクションを防止する。
 *
 * @param {string} raw Markdown原文
 * @param {string} docPath ドキュメント識別子（file_path）
 * @param {string} modified 更新日時文字列
 * @param {Array} [extraSources=[]] 呼び出し元から直接渡される追加sources
 * @returns {Promise<void>}
 */
async function ingestContent(raw, docPath, modified, extraSources = []) {
  // 環境変数 EXTRA_SOURCES からも sources を受け取る（knowledge-base.mjs 経由のパイプライン用）
  const envSources = process.env.EXTRA_SOURCES
    ? JSON.parse(process.env.EXTRA_SOURCES)
    : [];
  const { body, frontmatter } = parseFrontmatter(raw);
  const tree = remark().use(remarkGfm).parse(body);
  normalizeTree(tree);
  const chapters = extractChapters(tree, config.ingest.min_heading_level);

  if (chapters.length === 0) {
    echo(chalk.yellow('  ⚠ チャプターが取得できませんでした'));
    return;
  }

  const fileContent = extractTextContent(tree);
  const docSummary = buildDocumentSummary(generateHeadingTree(tree), fileContent);

  // トランザクション開始
  await exec('BEGIN TRANSACTION');
  try {
    // 既存の同名ファイルを削除（冪等性確保）
    await execute('DELETE FROM sources WHERE document_id = (SELECT id FROM documents WHERE file_path = $1)', [docPath]);
    await execute('DELETE FROM chapters WHERE document_id = (SELECT id FROM documents WHERE file_path = $1)', [docPath]);
    await execute('DELETE FROM documents WHERE file_path = $1', [docPath]);

    // ドキュメントをINSERT
    const docResult = await query(
      'INSERT INTO documents (file_path, content, summary, modified) VALUES ($1, $2, $3, $4) RETURNING id',
      [docPath, fileContent, docSummary, modified],
    );
    const docId = Number(docResult[0].id);

    // frontmatter.sources[] があれば sources テーブルにINSERT
    if (frontmatter.sources && Array.isArray(frontmatter.sources)) {
      for (const src of frontmatter.sources) {
        const url = src.url || src.path || src.source || '';
        const sourceType = src.source_type || 'web';
        const fetchedAt = src.fetched || modified;
        await execute(
          'INSERT OR IGNORE INTO sources (document_id, url, source_type, fetched) VALUES ($1, $2, $3, $4)',
          [docId, url, sourceType, fetchedAt],
        );
      }
    }

    // 呼び出し元から渡された extraSources を登録
    const allExtraSources = [...extraSources, ...envSources];
    if (allExtraSources.length > 0) {
      for (const src of allExtraSources) {
        await execute(
          'INSERT OR IGNORE INTO sources (document_id, url, source_type, fetched) VALUES ($1, $2, $3, $4)',
          [docId, src.url, src.source_type || 'ref', new Date().toISOString()],
        );
      }
    }

    // chapters行をINSERT
    for (const ch of chapters) {
      const weight = ch.level ? HEADING_WEIGHTS[ch.level] || 1.0 : null;
      const chSummary = getChapterSummary(ch.heading, ch.level, ch.content);
      const wakati = await tokenizeWithLindera(ch.content);
      await execute(
        'INSERT INTO chapters (document_id, heading, level, weight, chunk_index, content, summary, content_wakati) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [docId, ch.heading || '', ch.level ?? null, weight, ch.chunk_index, ch.content, chSummary, wakati],
      );
    }

    await exec('COMMIT');

    echo(chalk.green(`  ✅ ${chapters.length} チャプターを登録しました${frontmatter.title ? chalk.gray(`（タイトル: ${frontmatter.title}）`) : ''}`));
  } catch (e) {
    await exec('ROLLBACK');
    echo(chalk.red(`  ❌ エラーが発生したためロールバックしました: ${e.message}`));
    throw e;
  }
}

// ----------------------------------------
// 公開API(syncから呼び出す)
// ----------------------------------------

/**
 * Markdown文字列をナレッジベースに取り込む。
 *
 * @param {string} raw フロントマター付きMarkdown
 * @param {string} docPath ドキュメント識別子(プロジェクトルートからの相対パス)
 * @param {string|null} [modified=null] 更新日時。省略時は実ファイルのmtimeを使う
 * @returns {Promise<void>}
 */
export async function ingestMarkdown(raw, docPath, modified = null) {
  await ensureDependencies();

  let mtime = modified;
  if (!mtime) {
    try {
      mtime = fs.statSync(docPath).mtime.toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
    } catch {
      mtime = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
    }
  }

  await ingestContent(raw, docPath, mtime);
}

/**
 * FTSインデックスを再作成する(overwrite=1で冪等)。
 *
 * 全ファイルの取り込みが終わった後に1回だけ呼ぶ。
 *
 * @returns {Promise<void>}
 */
export async function rebuildFtsIndex() {
  await execute(`PRAGMA create_fts_index('chapters', 'id', 'heading', 'content_wakati', overwrite = 1)`);
}
