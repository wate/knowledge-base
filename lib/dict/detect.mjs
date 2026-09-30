// zx globals: $, argv, fs, path, chalk, glob, YAML, os

/**
 * @fileoverview 指定ディレクトリの.mdファイルからUNK(未知語)を抽出し、unknown_wordsテーブルに登録する。
 *
 * DBではなくファイルを直接読み込んで処理する。
 * YAMLフロントマターは除去してからトークナイズする。
 *
 * @usage
 * ```sh
 * knowledge-base.mjs dict detect --source-dir ../docs              # docs/を対象
 * knowledge-base.mjs dict detect --source-dir external/cakephp     # cakephp/を対象
 * knowledge-base.mjs dict detect --source-dir ../docs --source-dir external/cakephp  # 複数指定
 * knowledge-base.mjs dict detect                                    # カレントディレクトリを対象
 * ```
 */

import { ensureDependencies } from '../ensure-deps.mjs';
import { loadLindera, createTokenizer } from '../lindera.mjs';
import { query, execute } from '../db.mjs';
import { loadConfig } from '../config.mjs';

// UNKノイズフィルタ: 未知語候補から除外するトークンパターンの一覧
// ここにパターンを追加/削除/コメントアウトしてフィルタ強度を調整する
const preFilters = [ // 日本語判定より先に除外するパターン(言語を問わず明らかなノイズ)
  { name: 'ASCII記号のみ',    regex: /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+$/ },
  { name: '記号+日本語句読点のみ', regex: /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e\u3000-\u303f\u2460-\u24ff\u2500-\u257f\u25a0-\u25ff\u2600-\u26ff\uff00-\uffef]+$/ },
];
const JAPANESE_FILTERS = [ // 日本語を含む語にのみ適用するフィルタ
  { name: '単独漢字1文字',    regex: /^[\u4e00-\u9faf\u3400-\u4dbf]$/ },
  { name: '先頭/末尾に中黒',  regex: /^・|・$/ },
];
const NON_JAPANESE_FILTERS = [ // 日本語以外の語に適用するフィルタ
  { name: '英小文字のみ',     regex: /^[a-z]+$/ },
  { name: '数字のみ',         regex: /^[0-9]+$/ },
  { name: '2文字以下',        regex: /^.{1,2}$/ },
];

/**
 * トークン表面(surface)がノイズかどうかを判定する。
 *
 * 判定フロー:
 * 1. 即時除外フィルタ(preFilters)にマッチ → ノイズ
 * 2. 日本語文字(漢字・ひらがな・カタカナ)を含む場合
 *    a. 日本語専用フィルタ(JAPANESE_FILTERS)にマッチ → ノイズ
 *    b. 対象内
 * 3. 日本語を含まない場合
 *    a. 一般フィルタ(NON_JAPANESE_FILTERS)にマッチ → ノイズ
 *    b. 大文字を含む → 固有名詞候補として対象内
 *    c. 対象内
 *
 * @param {string} s トークンの表層形
 * @returns {boolean} ノイズと判断された場合は true
 */
function isNoiseToken(s) {
  // 1. 即時除外(記号のみ等)
  if (preFilters.some((f) => f.regex.test(s))) return true;

  // 2. 日本語を含む場合
  if (/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/.test(s)) {
    if (JAPANESE_FILTERS.some((f) => f.regex.test(s))) return true;
    return false;
  }

  // 3. 日本語を含まない場合
  if (NON_JAPANESE_FILTERS.some((f) => f.regex.test(s))) return true;
  if (/[A-Z]/.test(s)) return false;
  return false;
}

/**
 * ファイル内容からYAMLフロントマターを除去したMarkdown本文を返す。
 *
 * @param {string} content ファイルの生の内容
 * @returns {string} フロントマター除去後の本文
 */
function stripFrontmatter(content) {
  if (content.startsWith('---')) {
    const endIndex = content.indexOf('---', 3);
    if (endIndex !== -1) {
      return content.slice(endIndex + 3).trim();
    }
  }
  return content.trim();
}

/**
 * メイン処理。
 *
 * 指定ディレクトリの.mdファイルからUNK(未知語)を抽出し、
 * unknown_wordsテーブルに登録する。
 */
export async function run() {
  await ensureDependencies();

  const config = loadConfig();

  // `--source-dir` は複数指定可能(実行ディレクトリ基準)。未指定時は config.unknown_word_detection.source_dirs → ['.']
  const sourceDirs = argv['source-dir']
    ? (Array.isArray(argv['source-dir']) ? argv['source-dir'] : [argv['source-dir']])
    : (config.unknown_word_detection.source_dirs || ['.']);

  const lindera = loadLindera();
  const DICT_DIR = config.dictionary.system_dir;
  const DICT_TYPE = config.dictionary.type;
  const USER_DICT_PATH = config.dictionary.user_dict;

  const userDictPath = fs.existsSync(USER_DICT_PATH) ? USER_DICT_PATH : null;
  const tokenizer = await createTokenizer(lindera, DICT_DIR, userDictPath, DICT_TYPE);
  echo(chalk.green(`  ✅ Lindera初期化完了 (${DICT_DIR})`));

  echo(chalk.bold('\n🔍 UNK(未知語)抽出\n'));

  // 1. 対象ディレクトリから.mdファイルを収集
  const mdFiles = [];
  for (const dir of sourceDirs) {
    const absDir = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(absDir)) {
      echo(chalk.yellow(`  ⚠ ディレクトリが見つかりません: ${absDir}`));
      continue;
    }
    // 再帰的に.mdファイルを検索(zxのglobは非同期Promiseを返す)
    const pattern = path.join(absDir, '**/*.md');
    const files = await glob(pattern);
    for (const f of files) {
      mdFiles.push({ path: f, rel: path.relative(process.cwd(), f) });
    }
    echo(chalk.gray(`  ${dir}: ${files.length}個の.mdファイル`));
  }

  if (mdFiles.length === 0) {
    echo(chalk.yellow('  処理対象の.mdファイルがありません'));
    return;
  }
  echo(chalk.gray(`  合計: ${mdFiles.length}個の.mdファイル`));

  // 2. ファイルを読み込んでUNK抽出
  const unkCandidates = new Map(); // word → Set<rel_path>

  for (const { path: filePath, rel: relPath } of mdFiles) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const content = stripFrontmatter(raw);
      if (!content) continue;

      const tokens = tokenizer.tokenize(content);
      for (const token of tokens) {
        if (token.isUnknown) {
          const s = token.surface;
          if (isNoiseToken(s)) continue;
          if (!unkCandidates.has(s)) {
            unkCandidates.set(s, new Set());
          }
          unkCandidates.get(s).add(relPath);
        }
      }
    } catch (e) {
      echo(chalk.yellow(`  ⚠ ファイル読み込みエラー: ${relPath} (${e.message})`));
    }
  }

  echo(chalk.gray(`  抽出されたUNK候補(重複排除前): ${unkCandidates.size}語`));

  // 4. DB一括登録(一時テーブル経由でバルクUPSERT)
  const before = await query('SELECT COUNT(*) AS cnt FROM unknown_words');
  const beforeCount = Number(before[0]?.cnt ?? 0);
  let newCount = 0;
  let updateCount = 0;
  {
    // 全候補を一時テーブルに投入し、DB側で重複処理
    const allValues = [...unkCandidates]
      .map(([word, filePaths]) => {
        const src = [...filePaths].join(',');
        return `('${word.replace(/'/g, "''")}', '${src.replace(/'/g, "''")}')`;
      })
      .join(',\n');

    const stmts = [];
    stmts.push(
      `CREATE TEMP TABLE _unk_candidates AS SELECT * FROM (VALUES\n${allValues}\n) AS t(word, src);`,
    );

    // 新規レコードを一括INSERT(重複は無視)
    stmts.push(`
      INSERT INTO unknown_words (word, source_docs)
      SELECT word, src FROM _unk_candidates
      WHERE word NOT IN (SELECT word FROM unknown_words);
    `);

    // 既存レコードのsource_docsを追記
    stmts.push(`
      UPDATE unknown_words SET
        source_docs = CASE
          WHEN unknown_words.source_docs IS NULL OR unknown_words.source_docs = '' THEN _unk_candidates.src
          WHEN NOT contains(unknown_words.source_docs, _unk_candidates.src)
            THEN unknown_words.source_docs || ',' || _unk_candidates.src
          ELSE unknown_words.source_docs
        END,
        modified = now()
      FROM _unk_candidates
      WHERE unknown_words.word = _unk_candidates.word;
    `);

    stmts.push('DROP TABLE IF EXISTS _unk_candidates;');

    await execute(stmts.join(''));

    // 件数確認
    const after = await query('SELECT COUNT(*) AS cnt FROM unknown_words');
    const afterCount = Number(after[0]?.cnt ?? 0);
    newCount = afterCount - beforeCount;
    updateCount = unkCandidates.size - newCount;
  }

  echo(chalk.green(`\n  ✅ 完了: 新規${newCount}語, 既存更新${updateCount}語`));

  // 5. サマリ表示
  if (newCount > 0) {
    echo(chalk.bold('\n  新規追加された語 (先頭20件):'));
    const newWords = await query(
      `SELECT word, source_docs FROM unknown_words WHERE created >= current_timestamp - INTERVAL '1 minute' ORDER BY created DESC LIMIT 20`,
    );
    for (const w of newWords) {
      echo(chalk.cyan(`    ${w.word} (${w.source_docs})`));
    }
  }
}
