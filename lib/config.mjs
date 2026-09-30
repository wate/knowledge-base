/**
 * @fileoverview ナレッジベース設定読み込み共通モジュール
 *
 * .knowledge-base.yml から設定を読み込み、デフォルト値・環境変数とのマージを行う。
 * 設定優先順位: CLI引数 > .knowledge-base.yml > 環境変数(KNOWLEDGE_BASE_) > デフォルト値
 *
 * 設定ファイルの探索は process.cwd()（ワーキングディレクトリ）基準で行う。
 * 設定ファイル内の相対パスは base_dir(既定: process.cwd())基準で解決する。
 * 辞書とモデルの既定値は cache_dir(既定: knowledge-base.mjs と同じ階層の .cache)から導出する。
 * これにより、スクリプトの実態・設定ファイル・ワーキングディレクトリが
 * 異なる場所にあっても統一的な動作が可能。
 *
 * zxスクリプトから利用することを前提とし、zxがグローバル注入する YAML(js-yaml)を使用する。
 *
 * @example
 * ```javascript
 * import { loadConfig } from './lib/config.mjs';
 * const config = loadConfig();
 * console.log(config.database.path);
 * ```
 */

// ワーキングディレクトリを基準点とする(設定ファイルの探索に使う)
const BASE_DIR = process.cwd();

// knowledge-base.mjs があるディレクトリ。正本は knowledge-base/、同梱後は scripts/ になる
const KB_ROOT = path.resolve(import.meta.dirname, '..');

// キャッシュのルートの既定値
const DEFAULT_CACHE_DIR = path.resolve(KB_ROOT, '.cache');

/**
 * キャッシュのルートから辞書とモデルの既定値を導出する。
 *
 * @param {string} cacheDir キャッシュのルート(絶対パス)
 * @returns {{systemDir: string, userDict: string, modelCacheDir: string}} 導出したパス
 */
function deriveCachePaths(cacheDir) {
  return {
    systemDir: path.join(cacheDir, 'dict/system'),
    userDict: path.join(cacheDir, 'dict/user/user-dict.bin'),
    modelCacheDir: path.join(cacheDir, 'models'),
  };
}

/**
 * デフォルト設定値を組み立てる。
 *
 * 辞書とモデルのパスは cache_dir から導出する。
 * base_dir と cache_dir は絶対パスで持つ。
 *
 * @param {string} [cacheDir=DEFAULT_CACHE_DIR] キャッシュのルート
 * @returns {object} デフォルト設定値
 */
function buildDefaults(cacheDir = DEFAULT_CACHE_DIR) {
  const cache = deriveCachePaths(cacheDir);

  return {
    base_dir: BASE_DIR,
    cache_dir: cacheDir,
    database: {
      path: path.resolve(BASE_DIR, 'knowledge-base.duckdb'),
    },
    dictionary: {
      type: 'ipadic',
      system_dir: cache.systemDir,
      user_dict: cache.userDict,
    },
    sources: ['.'],
    source_mappings: [],
    ingest: {
      min_heading_level: 3,
    },
    source_local: {
      exclude_patterns: ['node_modules/**', '.git/**', 'vendor/**'],
    },
    unknown_word_detection: {
      source_dirs: null, // null → sources を参照
      filters: null,
    },
    embedding: {
      model: 'intfloat/multilingual-e5-small',
      dimensions: 384,
      batch_size: 32,
      cache_dir: cache.modelCacheDir,
    },
    search: {
      top_n_documents: 20,
      weights: {
        cosine: 0.65,
        pagerank: 0.05,
        heading: 0.2,
        position: 0.1,
      },
      hybrid_weights: {
        vector: 0.7,
        bm25: 0.3,
      },
    },
    heading_weights: {
      1: 9.0,
      2: 6.0,
      3: 3.0,
      4: 2.0,
      5: 1.5,
      6: 1.0,
    },
  };
}

/**
 * 環境変数から設定値を読み込む。
 *
 * base_dir と cache_dir に対応する環境変数を参照する。
 * 他の項目は設定ファイルで指定する。
 *
 * @returns {object} 環境変数由来の設定値（部分オブジェクト）
 */
function loadEnv() {
  const env = {};
  const prefix = 'KNOWLEDGE_BASE_';

  if (process.env[`${prefix}BASE_DIR`]) {
    env.base_dir = process.env[`${prefix}BASE_DIR`];
  }
  if (process.env[`${prefix}CACHE_DIR`]) {
    env.cache_dir = process.env[`${prefix}CACHE_DIR`];
  }

  return env;
}

/**
 * 深いマージを行う。
 * オブジェクトを再帰的にマージし、第2引数の値で第1引数の値を上書きする。
 *
 * @param {object} target マージ先
 * @param {object} source マージ元
 * @returns {object} マージ結果
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * .knowledge-base.yml / .knowledge-base.yaml を読み込み、パースする。
 *
 * process.cwd() 基準で設定ファイルを探索する。
 * configPath が指定された場合はそのパスを優先して読み込む。
 *
 * @param {string|null} [configPath=null] 明示的な設定ファイルパス
 * @returns {object|null} パース結果。読み込み失敗時は null
 */
function loadYamlConfig(configPath = null) {
  if (configPath) {
    // 指定されたパスを試す（絶対パス or process.cwd() 基準の相対パス）
    const absPath = path.resolve(BASE_DIR, configPath);
    try {
      const raw = fs.readFileSync(absPath, 'utf8');
      return YAML.parse(raw);
    } catch {
      echo(chalk.yellow(`  ⚠ 設定ファイルが見つかりません: ${absPath}`));
      return null;
    }
  }

  // .knowledge-base.yml と .knowledge-base.yaml の両方を探索
  const candidates = [
    path.resolve(BASE_DIR, '.knowledge-base.yml'),
    path.resolve(BASE_DIR, '.knowledge-base.yaml'),
  ];
  for (const candidatePath of candidates) {
    try {
      const raw = fs.readFileSync(candidatePath, 'utf8');
      return YAML.parse(raw);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 設定内の相対パスを base_dir 基準の絶対パスに解決する。
 *
 * base_dir 自体は process.cwd() 基準で解決する。
 *
 * @param {object} config 設定オブジェクト
 * @returns {object} パス解決済みの設定オブジェクト
 */
function resolvePaths(config) {
  const resolved = { ...config };

  // base_dir 自体を絶対パスへ解決する(基準は process.cwd())
  const baseDir = resolved.base_dir ? path.resolve(BASE_DIR, resolved.base_dir) : BASE_DIR;
  resolved.base_dir = baseDir;

  // cache_dir
  if (resolved.cache_dir && !path.isAbsolute(resolved.cache_dir)) {
    resolved.cache_dir = path.resolve(baseDir, resolved.cache_dir);
  }

  // database.path
  if (resolved.database?.path && !path.isAbsolute(resolved.database.path)) {
    resolved.database = { ...resolved.database, path: path.resolve(baseDir, resolved.database.path) };
  }

  // dictionary.system_dir の絶対パス解決
  if (resolved.dictionary?.system_dir && !path.isAbsolute(resolved.dictionary.system_dir)) {
    resolved.dictionary = {
      ...resolved.dictionary,
      system_dir: path.resolve(baseDir, resolved.dictionary.system_dir),
    };
  }

  // dictionary.user_dict の絶対パス解決
  if (resolved.dictionary?.user_dict && !path.isAbsolute(resolved.dictionary.user_dict)) {
    resolved.dictionary = {
      ...resolved.dictionary,
      user_dict: path.resolve(baseDir, resolved.dictionary.user_dict),
    };
  }

  return resolved;
}

/**
 * 設定値の検証エラー。CLIではexit 2(使い方・設定エラー)に対応付ける。
 */
export class ConfigValidationError extends Error {
  /**
   * @param {string[]} violations 違反内容(キー名と期待値を含む1行の文字列)の一覧
   */
  constructor(violations) {
    super(`設定値が不正です:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
    this.name = 'ConfigValidationError';
    this.violations = violations;
  }
}

/**
 * 設定値のサムチェック・範囲チェックを行う。
 *
 * @param {object} config 検証対象の設定オブジェクト
 * @returns {string[]} 違反内容の一覧。違反がなければ空配列
 */
export function validateConfig(config) {
  const violations = [];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const fmt = (v) => Number(v.toFixed(3));

  // search.weights: 合計1.0
  const wKeys = ['cosine', 'pagerank', 'heading', 'position'];
  const weights = config.search?.weights || {};
  const missingW = wKeys.filter((k) => !isNum(weights[k]));
  const wSum = wKeys.reduce((s, k) => s + (isNum(weights[k]) ? weights[k] : 0), 0);
  if (missingW.length > 0) {
    violations.push(`search.weights.${missingW[0]}: 数値を指定してください(現在: ${JSON.stringify(weights[missingW[0]])})`);
  } else if (Math.abs(wSum - 1.0) > 1e-6) {
    violations.push(`search.weights: 合計を1.0にしてください(現在: ${fmt(wSum)})`);
  }

  // search.hybrid_weights: 合計1.0
  const hKeys = ['vector', 'bm25'];
  const hybrid = config.search?.hybrid_weights || {};
  const missingH = hKeys.filter((k) => !isNum(hybrid[k]));
  const hSum = hKeys.reduce((s, k) => s + (isNum(hybrid[k]) ? hybrid[k] : 0), 0);
  if (missingH.length > 0) {
    violations.push(`search.hybrid_weights.${missingH[0]}: 数値を指定してください(現在: ${JSON.stringify(hybrid[missingH[0]])})`);
  } else if (Math.abs(hSum - 1.0) > 1e-6) {
    violations.push(`search.hybrid_weights: 合計を1.0にしてください(現在: ${fmt(hSum)})`);
  }

  // 範囲チェック
  const topN = config.search?.top_n_documents;
  if (!Number.isInteger(topN) || topN < 1 || topN > 1000) {
    violations.push(`search.top_n_documents: 1〜1000の整数を指定してください(現在: ${JSON.stringify(topN)})`);
  }

  const dimensions = config.embedding?.dimensions;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    violations.push(`embedding.dimensions: 1以上の整数を指定してください(現在: ${JSON.stringify(dimensions)})`);
  }

  const batchSize = config.embedding?.batch_size;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    violations.push(`embedding.batch_size: 1以上の整数を指定してください(現在: ${JSON.stringify(batchSize)})`);
  }

  const minLevel = config.ingest?.min_heading_level;
  if (!Number.isInteger(minLevel) || minLevel < 1 || minLevel > 6) {
    violations.push(`ingest.min_heading_level: 1〜6の整数を指定してください(現在: ${JSON.stringify(minLevel)})`);
  }

  return violations;
}

/**
 * 設定を読み込み、すべてのデフォルト値とマージして返す。
 *
 * 1. 環境変数と設定ファイルを読み、base_dir と cache_dir を決める
 * 2. cache_dir から辞書とモデルの既定値を組み立てる
 * 3. デフォルト値へ環境変数、設定ファイル、CLI引数を順に重ねる
 * 4. 相対パスを base_dir 基準で絶対パスへ解決する
 * 5. 検証する
 *
 * cliOverrides に `configFile` プロパティを含めると、
 * 設定ファイルのパスを明示的に指定できる（例: `{ configFile: '/path/to/config.yml' }`）。
 * `configFile` はマージ対象の設定キーではなく制御用パラメータとして扱われる。
 *
 * @param {object} [cliOverrides={}] CLI引数由来の上書き値
 * @returns {object} マージ済み設定オブジェクト
 */
export function loadConfig(cliOverrides = {}) {
  const { configFile, ...mergeOverrides } = cliOverrides;

  // 1. 環境変数と設定ファイルを読み、キャッシュのルートを決める
  //    優先順位は「CLI引数 > 設定ファイル > 環境変数 > 既定値」
  const envConfig = loadEnv();
  const yamlConfig = loadYamlConfig(configFile || null) || {};
  const cacheDirSource =
    mergeOverrides.cache_dir ?? yamlConfig.cache_dir ?? envConfig.cache_dir ?? DEFAULT_CACHE_DIR;
  const baseDirSource = mergeOverrides.base_dir ?? yamlConfig.base_dir ?? envConfig.base_dir ?? BASE_DIR;
  const baseDir = path.resolve(BASE_DIR, baseDirSource);
  const cacheDir = path.isAbsolute(cacheDirSource) ? cacheDirSource : path.resolve(baseDir, cacheDirSource);

  // 2. キャッシュのルートから辞書とモデルの既定値を組み立てる
  let config = buildDefaults(cacheDir);

  // 3. 環境変数、設定ファイルの順に重ねる
  if (Object.keys(envConfig).length > 0) {
    config = deepMerge(config, envConfig);
  }
  if (Object.keys(yamlConfig).length > 0) {
    config = deepMerge(config, yamlConfig);
  }

  // 4. 相対パスを base_dir 基準で絶対パスへ解決する
  config = resolvePaths(config);

  // 5. CLI引数で上書きする(configFile は制御用パラメータのため除外)
  if (Object.keys(mergeOverrides).length > 0) {
    config = deepMerge(config, mergeOverrides);
  }

  // 6. 検証: 違反があれば例外を投げ、CLIでexit 2として扱う
  const violations = validateConfig(config);
  if (violations.length > 0) {
    throw new ConfigValidationError(violations);
  }

  return config;
}
