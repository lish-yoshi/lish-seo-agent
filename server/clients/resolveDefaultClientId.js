/**
 * DEFAULT_CLIENT_ID の解決
 *
 * 本番環境では clientId の暗黙フォールバックを禁止する。
 * clientId 未指定のリクエストが DEFAULT_CLIENT_ID へ無言で流れると
 * 誤投稿の直接原因になるため。
 */

const raw = process.env.DEFAULT_CLIENT_ID || "";
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && raw) {
  console.error(
    `❌ DEFAULT_CLIENT_ID="${raw}" は本番環境では無視されます。` +
      " clientId を明示指定しないリクエストは 400 で拒否されます。"
  );
}

const DEFAULT_CLIENT_ID = isProduction ? "" : raw;

module.exports = DEFAULT_CLIENT_ID;
