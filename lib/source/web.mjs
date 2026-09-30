/**
 * @fileoverview Web(HTTP/HTTPS) source plugin
 *
 * WebからHTMLを取得する。Basic認証とBearerトークン認証に対応。
 *
 * @example
 * ```javascript
 * import { collect } from './lib/source/web.mjs';
 *
 * // 単純なHTTP取得
 * const result = await collect('https://example.com');
 *
 * // Basic認証
 * const result = await collect('https://example.com', {
 *   auth: { user: 'name', password: 'pass' }
 * });
 *
 * // Bearerトークン(環境変数 AUTH_TOKEN)
 * const result = await collect('https://example.com');
 * ```
 */

/**
 * WebからHTMLを取得する。
 *
 * @param {string} url 取得先URL
 * @param {object} [options={}] オプション
 * @param {object} [options.auth] 認証情報
 * @param {string} [options.auth.user] Basic認証ユーザー名
 * @param {string} [options.auth.password] Basic認証パスワード
 * @param {string} [options.auth.token] Bearerトークン(未指定時は AUTH_TOKEN 環境変数)
 * @returns {Promise<{ content: string, title: string, sourceType: string, sourceMeta: object, rawFilePath: null }>}
 */
export async function collect(url, options = {}) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`無効なURL: ${url}`);
  }

  // HTTPヘッダー準備
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeBase/1.0)',
  };

  // Basic認証
  const auth = options.auth || {};
  if (auth.user && auth.password) {
    const encoded = Buffer.from(`${auth.user}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  // Bearer認証（オプション > 環境変数）
  const token = auth.token || process.env.AUTH_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // HTTPリクエスト
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const content = await resp.text();

  // タイトル解決
  const title = resolveHtmlTitle(content, basename(url));

  return {
    content,
    title,
    sourceType: 'html',
    sourceMeta: {
      url,
      source_type: 'web',
    },
    rawFilePath: null,
  };
}

/**
 * URLからファイル名部分を取得する。
 *
 * @param {string} url
 * @returns {string}
 */
function basename(url) {
  try {
    const u = new URL(url);
    const name = u.pathname.split('/').filter(Boolean).pop() || '';
    return name.replace(/\.html?$/i, '') || 'untitled';
  } catch {
    return 'untitled';
  }
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
