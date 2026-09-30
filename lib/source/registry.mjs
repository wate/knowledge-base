/**
 * @fileoverview Source検出・マッピング管理
 *
 * ソース種別(local/web/redmine...)の検出と、対応するpluginモジュールへの
 * マッピングを管理する。extract registryと同様のプラグイン方式。
 *
 * 自動検出ルール:
 * - http:// / https:// 始まり → type: web
 * - それ以外 → type: local (ファイルパスまたはディレクトリ)
 *
 * @example
 * ```javascript
 * import { detectSource, detectAll } from './lib/source/registry.mjs';
 *
 * // 単一検出
 * const { type, sourceSpec } = detectSource('docs/');
 * // → { type: 'local', sourceSpec: 'docs/', options: {} }
 *
 * const { type, sourceSpec } = detectSource('https://example.com');
 * // → { type: 'web', sourceSpec: 'https://example.com', options: {} }
 * ```
 */

/**
 * ソース種別からpluginモジュールのパスへのマッピング。
 *
 * 新しいソース種別を追加する場合はここにエントリを追加する。
 *
 * @type {Object<string, string>}
 */
const SOURCE_REGISTRY = {
  local: './local.mjs',
  web: './web.mjs',
  // redmine: './redmine.mjs',   // TODO: 将来対応
  // github: './github.mjs',     // TODO: 将来対応
};

/**
 * 自動検出のためのURLパターン。
 *
 * http:// または https:// で始まる文字列をWeb URLとして検出する。
 *
 * @type {RegExp}
 */
const URL_PATTERN = /^https?:\/\//i;

/**
 * sourceSpecからソース種別を自動検出する。
 *
 * @param {string} sourceSpec ソース指定（ファイルパス、URL、または --source の引数）
 * @param {object} [cliOptions={}] --source に付随するオプション
 * @returns {{ type: string, sourceSpec: string, options: object }}
 *   type: plugin種別(local/web等)
 *   sourceSpec: 実際の取得先
 *   options: pluginに渡すオプション(auth等)
 */
export function detectSource(sourceSpec, cliOptions = {}) {
  // --source で type が明示指定されている場合
  if (cliOptions.type) {
    return {
      type: cliOptions.type,
      sourceSpec,
      options: { ...cliOptions },
    };
  }

  // URL自動検出
  if (URL_PATTERN.test(sourceSpec)) {
    return {
      type: 'web',
      sourceSpec,
      options: cliOptions,
    };
  }

  // デフォルト: local
  return {
    type: 'local',
    sourceSpec,
    options: cliOptions,
  };
}

/**
 * YAML設定の sources エントリを解釈し、一括処理用の配列を返す。
 *
 * settings.sources の各エントリ:
 * - 文字列 → 自動検出(detectSource)
 * - オブジェクト → { source, type?, auth? } 形式
 *
 * @param {Array} sourcesConfig .knowledge-base.yml の sources 配列
 * @returns {Array<{ type: string, sourceSpec: string, options: object }>}
 */
export function detectAll(sourcesConfig) {
  if (!Array.isArray(sourcesConfig)) return [];

  return sourcesConfig.map((entry) => {
    if (typeof entry === 'string') {
      // ショートハンド: 自動検出
      return detectSource(entry);
    }

    // 詳細形式: { source, type?, auth? }
    const sourceSpec = entry.source || entry.path || '';
    const options = {};
    if (entry.type) options.type = entry.type;
    if (entry.auth) options.auth = entry.auth;
    if (entry.excludes) options.excludes = entry.excludes;

    return detectSource(sourceSpec, options);
  });
}

/**
 * typeに対応するpluginモジュールを動的ロードする。
 *
 * @param {string} type ソース種別(local/web等)
 * @returns {Promise<object|null} pluginモジュール。未登録の場合は null
 */
export async function loadPlugin(type) {
  const modulePath = SOURCE_REGISTRY[type];
  if (!modulePath) return null;

  try {
    return await import(modulePath);
  } catch {
    return null;
  }
}

export { SOURCE_REGISTRY };
