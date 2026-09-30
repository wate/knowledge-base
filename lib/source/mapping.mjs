// zx globals: path

import picomatch from 'picomatch';

/**
 * ファイルパスにマッチする source_mapping を解決し、原本URLを生成する。
 *
 * 設定ファイル（.knowledge-base.yml）の source_mappings 定義に従い、
 * ローカルファイルパスから原本（公式ドキュメント等）のURLを生成する。
 *
 * @param {string} filePath 絶対ファイルパス
 * @param {Array} mappings source_mappings 設定配列
 * @param {string} baseDir プロジェクトルート（相対パス解決用、通常 process.cwd()）
 * @returns {{ url: string, source_type: string }|null} マッチした場合は URL 情報、マッチしなければ null
 */
export function resolveMapping(filePath, mappings, baseDir) {
  if (!mappings || mappings.length === 0) return null;

  const relPath = path.relative(baseDir, filePath);

  for (const mapping of mappings) {
    const isMatch = picomatch(mapping.match, { dot: true });
    if (!isMatch(relPath)) continue;

    // match パターンでマッチした部分より後ろのパスを取得
    // 例: match: "knowledge-base/external/cakephp/**"
    //     relPath: "knowledge-base/external/cakephp/controllers.md"
    //     → pathAfterMatch: "controllers.md"
    const globBase = mapping.match.replace('/**', '').replace('/*', '');
    const pathAfterMatch = relPath.startsWith(globBase + '/')
      ? relPath.slice(globBase.length + 1)
      : path.basename(relPath);

    let url = mapping.url_template.replace('{{ path }}', pathAfterMatch);

    // 拡張子置換
    if (mapping.replace_ext) {
      for (const [from, to] of Object.entries(mapping.replace_ext)) {
        if (url.endsWith(from)) {
          url = url.slice(0, -from.length) + to;
          break;
        }
      }
    }

    return { url, source_type: 'ref' };
  }

  return null;
}
