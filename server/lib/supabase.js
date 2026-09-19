/**
 * Supabase（PostgREST）クライアント（T-04 共通ライブラリ）
 *
 * server/clients/store.js の supabaseConfig / supabaseRequest と同じ流儀:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を readSecret で取得
 *   - apikey と Authorization: Bearer の両方に同じキーを渡す
 *     （新形式 sb_secret_… も旧 service_role JWT も同じ扱い）
 *   - HTTP は node-fetch
 *
 * エラーは code 付き Error。message は固定文言、詳細は detail（キー・URL をマスク済み）。
 *   SUPABASE_CONFIG_MISSING / SUPABASE_FETCH_FAILED / SUPABASE_UNIQUE_VIOLATION /
 *   SUPABASE_CHECK_VIOLATION / SUPABASE_HTTP_<status> / SUPABASE_BAD_JSON
 *
 * service role キーは RLS をバイパスする。バックエンドからのみ使うこと。
 */

const fetch = require("node-fetch");
const { readSecret, maskSecrets } = require("./secrets");

const TIMEOUT_MS = 30000;
const DEFAULT_PAGE_SIZE = 1000; // PostgREST の既定上限

function dbError(code, detail, extra) {
  const e = new Error(`データベース処理に失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  if (extra) Object.assign(e, extra);
  return e;
}

function config() {
  const url = readSecret("SUPABASE_URL");
  const key = readSecret("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw dbError("SUPABASE_CONFIG_MISSING", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/**
 * query をクエリ文字列にする。
 *   - 文字列ならそのまま（先頭の ? は除く）
 *   - オブジェクトなら { select: "*", id: "eq.abc", order: "id.asc", limit: 10 } の形
 *     値が undefined / null のキーは無視する
 */
function toQueryString(query) {
  if (!query) return "";
  if (typeof query === "string") return query.replace(/^\?/, "");
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

function constraintOf(message) {
  return (String(message || "").match(/constraint "([^"]+)"/) || [])[1] || null;
}

/**
 * PostgREST を呼び、パース済みの JSON を返す（本文なしは null）。
 * path は "/rest/v1/<table>" や "/rest/v1/rpc/<fn>" の形。
 */
async function request(method, path, { query, body, headers } = {}) {
  const { url, key } = config();
  const qs = toQueryString(query);
  const endpoint = `${url}${path}${qs ? `?${qs}` : ""}`;

  const reqHeaders = { apikey: key, Authorization: `Bearer ${key}` };
  if (body !== undefined) reqHeaders["Content-Type"] = "application/json";
  Object.assign(reqHeaders, headers || {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  let text = "";
  try {
    res = await fetch(endpoint, {
      method,
      headers: reqHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    const reason = err && err.name === "AbortError" ? `timeout (${TIMEOUT_MS}ms)` : err.message;
    throw dbError("SUPABASE_FETCH_FAILED", maskSecrets(reason, [key, url]));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // PostgREST のエラー本文: { code, message, details, hint }
    let pg = null;
    try {
      pg = JSON.parse(text);
    } catch (_) {
      /* JSON でない */
    }
    const detail = maskSecrets(text.slice(0, 500), [key, url]);
    if (pg && pg.code === "23505") {
      throw dbError("SUPABASE_UNIQUE_VIOLATION", detail, {
        pgCode: pg.code,
        constraint: constraintOf(pg.message),
        details: maskSecrets(pg.details || "", [key, url]),
      });
    }
    if (pg && pg.code === "23514") {
      throw dbError("SUPABASE_CHECK_VIOLATION", detail, {
        pgCode: pg.code,
        constraint: constraintOf(pg.message),
      });
    }
    throw dbError(`SUPABASE_HTTP_${res.status}`, detail, { status: res.status, pgCode: pg ? pg.code : null });
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw dbError("SUPABASE_BAD_JSON", maskSecrets(err.message, [key, url]));
  }
}

function tablePath(table) {
  return `/rest/v1/${encodeURIComponent(table)}`;
}

/**
 * 行を取得する。query は PostgREST のクエリ（select / フィルタ / order / limit / offset）。
 * 1000 行を超えうる場合は limit / offset を指定するか selectAll を使う。
 */
async function select(table, query) {
  const rows = await request("GET", tablePath(table), { query: query || { select: "*" } });
  if (!Array.isArray(rows)) throw dbError("SUPABASE_BAD_JSON", "配列以外の応答");
  return rows;
}

/**
 * limit / offset でページングして全件取得する。
 * ページ間で順序が変わらないよう、query に order を必ず指定すること（未指定なら警告）。
 */
async function selectAll(table, query, { pageSize = DEFAULT_PAGE_SIZE, maxRows = 1000000 } = {}) {
  const base = typeof query === "string" ? Object.fromEntries(new URLSearchParams(query.replace(/^\?/, ""))) : { ...(query || {}) };
  if (!base.select) base.select = "*";
  if (!base.order) {
    console.warn(`⚠️ [supabase.selectAll] ${table}: order が未指定です。ページ間で重複・欠落する可能性があります`);
  }
  const out = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await select(table, { ...base, limit: pageSize, offset });
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

/** 行を追加し、追加後の行を返す。rows はオブジェクトまたはその配列 */
async function insert(table, rows) {
  const result = await request("POST", tablePath(table), {
    body: rows,
    headers: { Prefer: "return=representation" },
  });
  return Array.isArray(result) ? result : [];
}

/**
 * 競合時は上書きする追加。onConflict は一意制約の列（カンマ区切り）。
 * 未指定なら主キーで判定される。
 */
async function upsert(table, rows, { onConflict } = {}) {
  const result = await request("POST", tablePath(table), {
    query: onConflict ? { on_conflict: onConflict } : undefined,
    body: rows,
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return Array.isArray(result) ? result : [];
}

/**
 * 条件に合う行を更新し、更新後の行を返す。
 * 全件更新の事故を防ぐため、フィルタの無い呼び出しは拒否する。
 */
async function update(table, query, patch) {
  const qs = toQueryString(query);
  const hasFilter = qs
    .split("&")
    .filter(Boolean)
    .some((p) => !/^(select|order|limit|offset|on_conflict|columns)=/.test(p));
  if (!hasFilter) {
    throw dbError("SUPABASE_HTTP_400", `update(${table}) にフィルタがありません。全件更新は許可していません`, { status: 400 });
  }
  const result = await request("PATCH", tablePath(table), {
    query: qs,
    body: patch,
    headers: { Prefer: "return=representation" },
  });
  return Array.isArray(result) ? result : [];
}

/** データベース関数を呼ぶ。戻り値は関数の定義による（配列とは限らない） */
async function rpc(fn, args) {
  return request("POST", `/rest/v1/rpc/${encodeURIComponent(fn)}`, { body: args || {} });
}

module.exports = { request, select, selectAll, insert, upsert, update, rpc };
