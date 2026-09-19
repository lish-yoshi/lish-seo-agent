/**
 * Google API 認証（T-04 共通ライブラリ）
 *
 * GSC / GA4 / BigQuery 用。ADC（Application Default Credentials）のみを使う。
 * 鍵ファイルや GOOGLE_APPLICATION_CREDENTIALS_JSON は読まない。
 *   - 本番: Cloud Run の実行サービスアカウント
 *   - ローカル: gcloud auth application-default login
 *
 * GOOGLE_IMPERSONATE_SA にサービスアカウントのメールを設定すると、
 * ADC の権限でその SA になりすます（ADC 側に roles/iam.serviceAccountTokenCreator が必要）。
 * 鍵を配布せずに、計測用の専用 SA の権限でローカル検証ができる。
 *
 * 既存の Sheets / Drive 認証（server/api/spreadsheet-*.js）はこのモジュールを使わない。
 */

const { GoogleAuth, Impersonated } = require("google-auth-library");
const { readSecret, maskSecrets } = require("./secrets");

const GSC_READONLY = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_READONLY = "https://www.googleapis.com/auth/analytics.readonly";
const BIGQUERY = "https://www.googleapis.com/auth/bigquery";
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

const TOKEN_LIFETIME_SEC = 3600;

// スコープの組（＋なりすまし先）ごとにクライアントをキャッシュする
const clientCache = new Map();

function authError(detail) {
  const e = new Error("Google 認証に失敗しました (GOOGLE_AUTH_FAILED)");
  e.code = "GOOGLE_AUTH_FAILED";
  if (detail) e.detail = maskSecrets(detail, []);
  return e;
}

function normalizeScopes(scopes) {
  const list = (Array.isArray(scopes) ? scopes : [scopes]).filter((s) => typeof s === "string" && s);
  if (list.length === 0) throw authError("スコープが指定されていません");
  return Array.from(new Set(list)).sort();
}

/** スコープに対応する認証クライアントを返す（キャッシュあり） */
async function getAuthClient(scopes) {
  const list = normalizeScopes(scopes);
  const target = readSecret("GOOGLE_IMPERSONATE_SA");
  const cacheKey = `${target}|${list.join(" ")}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);

  const pending = (async () => {
    try {
      if (!target) {
        return await new GoogleAuth({ scopes: list }).getClient();
      }
      // なりすまし元は IAM Credentials API を呼ぶため cloud-platform スコープが要る
      const sourceClient = await new GoogleAuth({ scopes: [CLOUD_PLATFORM] }).getClient();
      return new Impersonated({
        sourceClient,
        targetPrincipal: target,
        targetScopes: list,
        delegates: [],
        lifetime: TOKEN_LIFETIME_SEC,
      });
    } catch (err) {
      clientCache.delete(cacheKey);
      throw authError(err.message);
    }
  })();

  clientCache.set(cacheKey, pending);
  return pending;
}

/** アクセストークン文字列を返す。呼び出し側はログに出さないこと */
async function getAccessToken(scopes) {
  const client = await getAuthClient(scopes);
  try {
    const res = await client.getAccessToken();
    const token = res && typeof res === "object" ? res.token : res;
    if (!token || typeof token !== "string") throw new Error("トークンが空です");
    return token;
  } catch (err) {
    if (err && err.code === "GOOGLE_AUTH_FAILED") throw err;
    throw authError(err.message);
  }
}

module.exports = {
  getAuthClient,
  getAccessToken,
  GSC_READONLY,
  GA4_READONLY,
  BIGQUERY,
  CLOUD_PLATFORM,
};
