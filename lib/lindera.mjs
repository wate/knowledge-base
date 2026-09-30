/**
 * @fileoverview Linderaバインディング(lindera)の共通モジュール。
 *
 * loadLindera() でプラットフォームに応じたネイティブバイナリを解決し、
 * createTokenizer() / tokenizeToWakati() で分かち書き処理を提供する。
 * 後方互換のため CLI(lindera tokenize)への依存は排除している。
 *
 * @usage
 * ```js
 * import { loadLindera, ensureDictionary, createTokenizer, tokenizeToWakati } from './lib/lindera.mjs';
 *
 * const lindera = loadLindera();
 * await ensureDictionary('/path/to/dict', 'ipadic');
 * const tokenizer = createTokenizer(lindera, '/path/to/dict', null, 'ipadic');
 * const wakati = tokenizeToWakati(tokenizer, '日本語のテキスト');
 * ```
 */

// ----------------------------------------
// Linderaローダー
// ----------------------------------------

/** @type {string} プロジェクトルート（lib/の1つ上） */
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * プラットフォームに応じたLinderaネイティブバイナリのパスを解決する。
 *
 * linderaのnpmパッケージにindex.js(JSラッパー)が同梱されていない場合に備え、
 * 直接require('lindera')を試し、失敗したらプラットフォーム別パッケージの
 * .nodeファイルを直接読み込む。
 *
 * @returns {object} linderaのネイティブモジュール
 * @throws {Error} プラットフォーム別パッケージが見つからない場合
 */

export function loadLindera() {
  const modPath = path.resolve(ROOT, 'node_modules/lindera');

  // 先にindex.jsの存在を確認
  try {
    fs.accessSync(path.join(modPath, 'index.js'));
    // index.jsがあれば通常のrequireで読み込める
    return require(path.join(modPath, 'index.js'));
  } catch {
    // index.jsがない場合: プラットフォーム別パッケージから直接読み込む
  }

  // インストール済みのプラットフォーム別パッケージを探す
  const nmDir = path.resolve(ROOT, 'node_modules');
  const platformPkgs = fs.readdirSync(nmDir)
    .filter((name) => name.startsWith('lindera-') && name !== 'lindera');

  if (platformPkgs.length === 0) {
    throw new Error(
      'linderaのプラットフォーム別パッケージが見つかりません。\n' +
      '`npm install lindera` を実行してください。',
    );
  }

  // 最初に見つかったプラットフォーム別パッケージを使用
  // 通常は1つだけインストールされている(lindera-darwin-arm64 等)
  const pkgDir = path.join(nmDir, platformPkgs[0]);
  const binName = `lindera.${platformPkgs[0].replace('lindera-', '')}.node`;
  const binPath = path.join(pkgDir, binName);

  try {
    fs.accessSync(binPath);
  } catch {
    throw new Error(
      `ネイティブバイナリが見つかりません: ${binPath}\n` +
      `プラットフォーム別パッケージ ${platformPkgs[0]} の内容を確認してください。`,
    );
  }

  return require(binPath);
}

/**
 * lindera のパッケージバージョンを取得する。
 *
 * @returns {string} バージョン文字列（例: "6.2.0"）
 * @throws {Error} パッケージの取得に失敗した場合
 */
function getLinderaVersion() {
  const pkgPath = path.resolve(ROOT, 'node_modules/lindera/package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  } catch {
    throw new Error(
      'lindera のバージョンが取得できません。\n' +
      '`npm install lindera` を実行してください。',
    );
  }
}

/**
 * 辞書ディレクトリの実体を設定に合わせる。
 *
 * 辞書が無い場合はGitHub Releasesから自動ダウンロードして展開する。
 * 辞書はあるが設定と種別が一致しない場合は、既存の内容を削除して再取得する。
 * ダウンロード元: https://github.com/lindera/lindera/releases
 *
 * @param {string} dictDir 辞書ディレクトリの絶対パス
 * @param {string} [dictType='ipadic'] 辞書種別（例: ipadic, unidic）
 * @param {object} [options={}] オプション
 * @param {boolean} [options.force=false] 一致していても再取得する
 * @returns {Promise<void>}
 */
export async function ensureDictionary(dictDir, dictType = 'ipadic', { force = false } = {}) {
  const dictName = path.basename(dictDir);
  const archiveBase = `lindera-${dictType}`;
  const version = getLinderaVersion();
  const url = `https://github.com/lindera/lindera/releases/download/v${version}/${archiveBase}-${version}.zip`;

  // 辞書がある場合は設定との一致を確認し、必要なら再取得する
  const hasDictionary = fs.existsSync(path.join(dictDir, 'metadata.json'));
  if (hasDictionary) {
    if (isDictionaryConsistent(dictDir, dictType) && !force) return;

    if (force) {
      echo(chalk.yellow(`\n  ♻ --force: 辞書を再取得します: ${dictName}`));
    } else {
      const currentName = readDictionaryName(dictDir) ?? '(不明)';
      echo(chalk.yellow(`\n  ⚠ 辞書が設定と一致しません(現在: ${currentName} / 設定: ${dictType})`));
      echo(chalk.yellow('  再取得します'));
    }
    removeDictionaryContents(dictDir);
  } else {
    echo(chalk.yellow(`\n  ⬇ Lindera辞書が見つかりません: ${dictName}`));
  }
  echo(chalk.yellow(`  自動ダウンロードを開始します: ${archiveBase}-${version}.zip`));

  // 一時ディレクトリを作成してダウンロード
  const tmpDir = path.join(os.tmpdir(), `lindera-dict-${Date.now()}`);
  const zipPath = path.join(tmpDir, `${dictName}.zip`);
  const extractDir = path.join(tmpDir, 'extracted');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    // curl でダウンロード（プログレス表示）
    await $`curl -fL ${url} -o ${zipPath}`;

    // ZIP を展開
    await $`unzip -q ${zipPath} -d ${extractDir}`;

    // 展開先に version サフィックス付きディレクトリができる想定
    // （例: lindera-ipadic-6.2.0/）
    const extractedItems = fs.readdirSync(extractDir);
    const versionedDir = extractedItems.find(
      (name) => name.startsWith(archiveBase) && fs.statSync(path.join(extractDir, name)).isDirectory(),
    );

    if (versionedDir) {
      // 対象ディレクトリを作成して移動
      fs.mkdirSync(dictDir, { recursive: true });
      const srcDir = path.join(extractDir, versionedDir);
      for (const item of fs.readdirSync(srcDir)) {
        fs.renameSync(path.join(srcDir, item), path.join(dictDir, item));
      }
    } else {
      // versionedDir が見つからない場合は extractDir 直下の内容をそのまま移動
      fs.mkdirSync(dictDir, { recursive: true });
      for (const item of extractedItems) {
        const srcPath = path.join(extractDir, item);
        fs.renameSync(srcPath, path.join(dictDir, item));
      }
    }

    echo(chalk.green(`  ✅ 辞書ダウンロード完了: ${dictName} (${version})`));
  } catch (e) {
    echo(chalk.red(`  ❌ 辞書のダウンロードに失敗しました: ${dictName}`));
    echo(chalk.red(`  ${e.message}`));
    echo(chalk.yellow(`  手動でダウンロードしてください:`));
    echo(chalk.yellow(`  ${url}`));
    throw e;
  } finally {
    // 一時ファイルをクリーンアップ
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 一時ディレクトリの削除失敗は無視する(意図的なフォールバック) */ }
  }
}

/**
 * 辞書ディレクトリのmetadata.jsonから辞書名を読み取る。
 *
 * @param {string} dictDir 辞書ディレクトリのパス
 * @returns {string|null} 辞書名。metadata.jsonが無い、または読めない場合はnull
 */
function readDictionaryName(dictDir) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(dictDir, 'metadata.json'), 'utf8'));
    return typeof metadata.name === 'string' ? metadata.name : null;
  } catch {
    // metadata.jsonが無い、またはJSONとして読めない場合
    return null;
  }
}

/**
 * 辞書ディレクトリの実体が指定の種別と一致するかを判定する。
 *
 * metadata.jsonの`name`を期待する種別と比較する。ファイルの書き換えは行わない。
 * `format_version`は期待値をLinderaから取得できないため判定に使わない。
 *
 * @param {string} dictDir 辞書ディレクトリのパス
 * @param {string} dictType 期待する辞書種別(例: ipadic)
 * @returns {boolean} `name`が一致すればtrue、不一致またはmetadata.jsonが無い・読めない場合はfalse
 */
export function isDictionaryConsistent(dictDir, dictType) {
  return readDictionaryName(dictDir) === dictType;
}

/**
 * 辞書ディレクトリの内容を削除する(ディレクトリ自体は残す)。
 *
 * metadata.jsonのみを削除すると旧辞書のファイルが残るため、内容全体を削除する。
 *
 * @param {string} dictDir 辞書ディレクトリのパス
 * @returns {void}
 */
function removeDictionaryContents(dictDir) {
  for (const entry of fs.readdirSync(dictDir)) {
    fs.rmSync(path.join(dictDir, entry), { recursive: true, force: true });
  }
}

// ----------------------------------------
// Tokenizer生成
// ----------------------------------------

/**
 * Lindera Tokenizerを生成する。
 *
 * @param {object} lindera loadLindera() で取得したlinderaモジュール
 * @param {string} dictDir 辞書ディレクトリのパス
 * @param {string|null} userDictPath ユーザー辞書の.binファイルパス（未指定時はnull）
 * @param {string} [dictType='ipadic'] 辞書種別（例: ipadic, unidic）
 * @returns {Promise<object>} Tokenizerインスタンス
 *
 * @example
 * ```js
 * const lindera = loadLindera();
 * const tokenizer = await createTokenizer(lindera, '/path/to/dict', null, 'ipadic');
 * ```
 */
export async function createTokenizer(lindera, dictDir, userDictPath = null, dictType = 'ipadic') {
  // 辞書が存在しない場合は自動ダウンロード
  await ensureDictionary(dictDir, dictType);
  if (userDictPath && fs.existsSync(userDictPath)) {
    const builder = new lindera.TokenizerBuilder();
    builder.setDictionary(dictDir);
    builder.setUserDictionary(userDictPath);
    return builder.build();
  }
  const dictionary = lindera.loadDictionary(dictDir);
  return new lindera.Tokenizer(dictionary, 'normal');
}

// ----------------------------------------
// 分かち書き
// ----------------------------------------

/**
 * Tokenizerでテキストをトークナイズし、スペース区切りの表層形（分かち書き）を返す。
 *
 * @param {object} tokenizer Tokenizerインスタンス
 * @param {string} text 入力テキスト
 * @returns {string} スペース区切りの分かち書き結果。空入力の場合は空文字。
 */
export function tokenizeToWakati(tokenizer, text) {
  if (!text || text.trim().length === 0) return '';
  try {
    const tokens = tokenizer.tokenize(text);
    return tokens.map((t) => t.surface).join(' ');
  } catch (e) {
    echo(chalk.yellow(`  ⚠ トークナイズに失敗したため原文を使用します: ${e.message}`));
    return text;
  }
}
