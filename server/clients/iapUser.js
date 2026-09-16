/**
 * IAP 通過ユーザーの検証（T-01b-1）
 *
 * 本番（NODE_ENV=production）では LB → IAP が付ける
 *   X-Goog-IAP-JWT-Assertion
 * を Google の公開鍵で検証し、payload.email を利用者として扱う。
 * X-Goog-Authenticated-User-Email は LB が上書きするヘッダーだが、
 * 参考値に留め、認可判定には署名検証済みの JWT だけを使う。
 *
 * ローカル開発では IAP が無いため x-dev-user-email ヘッダー、
 * 無ければ "local-dev" を利用者として扱う。
 *
 * 使い方:
 *   app.post("/api/admin/clients", requireIapUser, handler)
 *   → handler 内で req.iapUser = { email, source: "iap" | "dev" }
 */

const { OAuth2Client } = require("google-auth-library");

// LB のバックエンドサービス（bes-backend-server）を audience にする
const IAP_AUDIENCE =
  process.env.IAP_AUDIENCE ||
  "/projects/1095775625088/global/backendServices/8732796228171828916";
const IAP_ISSUERS = ["https://cloud.google.com/iap"];
const ALLOWED_DOMAIN = (process.env.IAP_ALLOWED_DOMAIN || "lishinc.com").toLowerCase();
const PUBKEY_TTL_MS = 10 * 60 * 1000;

const oauth = new OAuth2Client();
let pubkeyCache = { at: 0, keys: null };

/** IAP 公開鍵を取得（10 分キャッシュ）。テストからは _setPublicKeys で差し替え可能 */
async function getPublicKeys() {
  if (pubkeyCache.keys && Date.now() - pubkeyCache.at < PUBKEY_TTL_MS) {
    return pubkeyCache.keys;
  }
  const { pubkeys } = await oauth.getIapPublicKeys();
  pubkeyCache = { at: Date.now(), keys: pubkeys };
  return pubkeys;
}

function _setPublicKeys(keys) {
  pubkeyCache = { at: keys ? Date.now() : 0, keys };
}

/**
 * IAP の JWT を検証してメールを返す。失敗時は code 付きの Error を投げる。
 * JWT の文字列自体はログにもエラーにも含めない。
 */
async function verifyIapJwt(jwt, { audience = IAP_AUDIENCE } = {}) {
  if (!jwt || typeof jwt !== "string") {
    throw iapError("IAP_REQUIRED", "IAP の JWT がありません");
  }
  let ticket;
  try {
    const keys = await getPublicKeys();
    ticket = await oauth.verifySignedJwtWithCertsAsync(jwt, keys, audience, IAP_ISSUERS);
  } catch (err) {
    // ライブラリのメッセージには JWT の payload が丸ごと付くことがあるので、先頭の要旨だけ残す
    const brief = String(err.message || "").split(/[:{]/)[0].trim();
    throw iapError("IAP_INVALID", `IAP の JWT 検証に失敗: ${brief}`);
  }
  const payload = ticket.getPayload() || {};
  const email = String(payload.email || "").trim().toLowerCase();
  if (!email) throw iapError("IAP_INVALID", "IAP の JWT に email がありません");
  if (!email.endsWith("@" + ALLOWED_DOMAIN)) {
    throw iapError("IAP_DOMAIN_NOT_ALLOWED", `許可されていないドメインです: ${email}`);
  }
  return email;
}

function iapError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** "accounts.google.com:foo@example.com" → "foo@example.com" */
function stripIapPrefix(value) {
  return String(value || "").replace(/^accounts\.google\.com:/, "").trim().toLowerCase();
}

/** 書き込みルート用ミドルウェア */
async function requireIapUser(req, res, next) {
  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    const email = stripIapPrefix(req.headers["x-dev-user-email"]) || "local-dev";
    req.iapUser = { email, source: "dev" };
    return next();
  }

  try {
    const email = await verifyIapJwt(req.headers["x-goog-iap-jwt-assertion"]);
    req.iapUser = { email, source: "iap" };
    return next();
  } catch (err) {
    const code = err.code || "IAP_INVALID";
    const status = code === "IAP_DOMAIN_NOT_ALLOWED" ? 403 : 401;
    console.warn(`🚫 IAP 検証失敗 (${code}): ${req.method} ${req.path} - ${err.message}`);
    return res.status(status).json({ error: "IAP 認証が必要です", code });
  }
}

module.exports = {
  requireIapUser,
  verifyIapJwt,
  stripIapPrefix,
  IAP_AUDIENCE,
  _setPublicKeys,
};
