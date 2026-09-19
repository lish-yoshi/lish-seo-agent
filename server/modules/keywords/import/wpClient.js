/**
 * WordPress REST の読み取り専用クライアント（T-07）。GET のみ。
 *
 * ベース URL と Basic 認証の組み立ては server/cms/wordpress.js の endpoint() / authHeader() と
 * 同じ内容を複製している（あちらはモジュール内の非公開関数で、server/cms/ は変更しない方針のため）。
 *
 * エラーは server/lib の流儀: code 付き Error、message は固定文言、詳細は detail（マスク済み）。
 *   CMS_CONFIG_MISSING / CMS_TYPE_UNSUPPORTED / CMS_FETCH_FAILED / CMS_HTTP_<status> / CMS_BAD_RESPONSE
 */

const fetch = require("node-fetch");
const { maskSecrets } = require("../../../lib/secrets");

const TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [1000, 2000]; // 429 / 5xx のみ。最大 2 回リトライ
const USER_AGENT = "lish-seo-agent/1.0";
const POST_FIELDS = "id,link,slug,status,type,date_gmt,modified_gmt,title,content";

function cmsError(code, detail, extra) {
  const e = new Error(`CMS からの取得に失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  if (extra) Object.assign(e, extra);
  return e;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** client.cms から接続情報を取り出す。不足していれば CMS_CONFIG_MISSING */
function connection(client) {
  const cms = (client && client.cms) || {};
  if (cms.type !== "wordpress") {
    throw cmsError("CMS_TYPE_UNSUPPORTED", `cms.type=${cms.type || "(未設定)"} は取り込みに未対応です（対応: wordpress）`);
  }
  const creds = cms.credentials || {};
  if (!cms.baseUrl || !creds.username || !creds.password) {
    throw cmsError("CMS_CONFIG_MISSING", "cms.baseUrl / ユーザー名 / アプリケーションパスワードのいずれかが未設定です");
  }
  const basic = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  return {
    base: `${String(cms.baseUrl).replace(/\/+$/, "")}/wp-json/wp/v2/`,
    authorization: `Basic ${basic}`,
    secrets: [creds.password, basic],
  };
}

/** GET して { data, headers } を返す。429 / 5xx はリトライ */
async function get(conn, pathAndQuery) {
  const url = conn.base + pathAndQuery;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    let text = "";
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: conn.authorization, Accept: "application/json", "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const reason = err && err.name === "AbortError" ? `timeout (${TIMEOUT_MS}ms)` : err.message;
      throw cmsError("CMS_FETCH_FAILED", maskSecrets(`${pathAndQuery}: ${reason}`, conn.secrets));
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      try {
        return { data: JSON.parse(text), headers: res.headers };
      } catch (err) {
        throw cmsError("CMS_BAD_RESPONSE", maskSecrets(`${pathAndQuery}: JSON を解釈できません（先頭: ${text.slice(0, 80)}）`, conn.secrets));
      }
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw cmsError(`CMS_HTTP_${res.status}`, maskSecrets(`${pathAndQuery}: ${text.slice(0, 300)}`, conn.secrets), {
      status: res.status,
      attempts: attempt + 1,
    });
  }
}

/**
 * 投稿タイプのスラッグ（post / page / カスタム投稿タイプ）を REST の rest_base に解決する。
 * 戻り値: [{ slug, restBase }]。存在しないスラッグがあれば CMS_BAD_RESPONSE
 */
async function resolveRestBases(client, typeSlugs) {
  const conn = connection(client);
  const { data } = await get(conn, "types");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw cmsError("CMS_BAD_RESPONSE", "types の応答がオブジェクトではありません");
  }
  const out = [];
  const missing = [];
  for (const slug of typeSlugs) {
    const def = data[slug];
    if (def && typeof def.rest_base === "string" && def.rest_base) out.push({ slug, restBase: def.rest_base });
    else missing.push(slug);
  }
  if (missing.length) {
    throw cmsError("CMS_BAD_RESPONSE", `投稿タイプが見つかりません: ${missing.join(", ")}（利用可能: ${Object.keys(data).join(", ")}）`);
  }
  return out;
}

/**
 * 公開済みの投稿を全件取得する。X-WP-TotalPages までページを回す。
 * onPage({ page, totalPages, fetched, total }) はページごとに呼ばれる（進捗表示用）。
 */
async function listAll(client, restBase, { perPage = 50, onPage } = {}) {
  const conn = connection(client);
  const size = Math.max(1, Math.min(Number(perPage) || 50, 100));
  const rows = [];
  let totalPages = 1;
  let total = 0;

  for (let page = 1; page <= totalPages; page++) {
    const query =
      `status=publish&context=view&_fields=${POST_FIELDS}` +
      `&orderby=id&order=asc&per_page=${size}&page=${page}`;
    const { data, headers } = await get(conn, `${encodeURIComponent(restBase)}?${query}`);
    if (!Array.isArray(data)) {
      throw cmsError("CMS_BAD_RESPONSE", `${restBase} page=${page}: 配列以外の応答`);
    }
    if (page === 1) {
      totalPages = Math.max(1, Number(headers.get("x-wp-totalpages")) || 1);
      total = Number(headers.get("x-wp-total")) || 0;
    }
    rows.push(...data);
    if (typeof onPage === "function") {
      await onPage({ page, totalPages, fetched: rows.length, total });
    }
    if (data.length === 0) break;
  }
  return { rows, total, totalPages };
}

module.exports = { resolveRestBases, listAll };
