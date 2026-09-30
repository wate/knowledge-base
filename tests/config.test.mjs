/**
 * @fileoverview lib/config.mjs の単体テスト
 *
 * 設定の解決規則(base_dir・cache_dirと辞書・モデルの導出)を検証する。
 * 設定ファイルは一時ディレクトリへ書き、`--config`相当の指定で読み込む。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadConfig } from '../lib/config.mjs';

const KB_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_CACHE_DIR = path.join(KB_ROOT, '.cache');

/**
 * 設定ファイルを一時ディレクトリへ書き、そのパスを返す。
 *
 * @param {string} body YAMLの本文
 * @returns {string} 書き出したファイルのパス
 */
function writeConfig(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-config-test-'));
  const file = path.join(dir, '.knowledge-base.yml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('cache_dir未指定: 辞書とモデルが既定のキャッシュ配下になる', () => {
  const config = loadConfig({ configFile: writeConfig('sources:\n  - docs\n') });

  assert.equal(config.cache_dir, DEFAULT_CACHE_DIR);
  assert.equal(config.dictionary.system_dir, path.join(DEFAULT_CACHE_DIR, 'dict/system'));
  assert.equal(config.dictionary.user_dict, path.join(DEFAULT_CACHE_DIR, 'dict/user/user-dict.bin'));
  assert.equal(config.embedding.cache_dir, path.join(DEFAULT_CACHE_DIR, 'models'));
  assert.equal(config.dictionary.type, 'ipadic');
});

test('cache_dir指定: 辞書とモデルがその配下へ導出される', () => {
  const cache = path.join(os.tmpdir(), 'kb-cache-test');
  const config = loadConfig({ configFile: writeConfig(`cache_dir: ${cache}\n`) });

  assert.equal(config.cache_dir, cache);
  assert.equal(config.dictionary.system_dir, path.join(cache, 'dict/system'));
  assert.equal(config.embedding.cache_dir, path.join(cache, 'models'));
});

test('個別指定: dictionary.system_dirがcache_dirより優先される', () => {
  const cache = path.join(os.tmpdir(), 'kb-cache-test2');
  const systemDir = path.join(os.tmpdir(), 'kb-dict-test');
  const body = `cache_dir: ${cache}\ndictionary:\n  system_dir: ${systemDir}\n`;
  const config = loadConfig({ configFile: writeConfig(body) });

  assert.equal(config.dictionary.system_dir, systemDir);
  assert.equal(config.embedding.cache_dir, path.join(cache, 'models'));
});

test('base_dir指定: 設定内の相対パスがbase_dir基準で解決される', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-base-test-'));
  const body = `base_dir: ${baseDir}\ndatabase:\n  path: kb.duckdb\n`;
  const config = loadConfig({ configFile: writeConfig(body) });

  assert.equal(config.base_dir, baseDir);
  assert.equal(config.database.path, path.join(baseDir, 'kb.duckdb'));
});
