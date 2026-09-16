/**
 * クライアント設定ストア
 *
 * これまで .env の単一値だった「投稿先・スプレッドシート・ブランド情報」を
 * clientId をキーに引ける形にまとめる層。
 *
 * 認証情報そのものはここには保存しない。
 * 設定には「どの環境変数を読むか」の名前だけを持たせ、実際の値は
 * ローカルでは .env、本番では Cloud Run のシークレット参照から解決する。
 * これによりクライアント一覧を Git や DB に置いても資格情報が漏れない。
 *
 * データソース:
 *   CLIENT_STORE=file      … CLIENTS_FILE のJSONを読む（既定 / ロールバック用）
 *   CLIENT_STORE=supabase  … Supabase の clients テーブルを読む（本番の正典。T-01 で移行）
 *
 * どちらの経路も normalize() を通すため、呼び出し側は同じ形の配列を受け取る。
 * 書き込み（createClientRow / updateClientRow）は supabase 経路のみ。
 * file 経路は読み取り専用（ロールバック用）。
 */

const fs = require("fs");
const path = require("path");

const STORE_KIND = process.env.CLIENT_STORE || "file";
const CLIENTS_FILE =
  process.env.CLIENTS_FILE || path.join(__dirname, "..", "..", "clients.json");
const CACHE_TTL_MS = Number(process.env.CLIENT_CACHE_TTL_MS || 60000);

let cache = { at: 0, clients: null };

/** 環境変数名を実値に解決する。未設定なら null。 */
function fromEnv(varName) {
  if (!varName) return null;
  const v = process.env[varName];
  return v && v.trim() !== "" ? v : null;
}

/**
 * Secret Manager 由来の値を読む。
 * 登録時に末尾の改行や制御文字が混ざることがあり、そのまま HTTP ヘッダーに
 * 載せると fetch が「不正なヘッダー」で失敗する。制御文字を除去して trim する。
 */
function readSecret(varName) {
  const raw = process.env[varName];
  if (typeof raw !== "string") return "";
  return raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/** jsonb に保持された実値。空文字・非文字列は null 扱い */
function literal(v) {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** text[] 列の正規化。文字列 1 件は配列に、それ以外は [] */
function toArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string" && v.trim() !== "") return [v];
  return [];
}

/** 管理 API の応答で password / apiKey の実値を隠す固定文字列 */
const CREDENTIAL_MASK = "••••••••";

/** 秘密値をログやエラー文から伏せる。値が空なら何もしない。 */
function maskSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("***");
  }
  return out;
}

/**
 * ストア読み込みエラーを、外部に返してよい形に落とす。
 * 認証情報や生のエラー文は含めず、固定文言＋エラー種別（code）だけにする。
 * /api/health の clientStoreError はこれを使う。
 */
function describeError(err) {
  const code = (err && err.code) || "CLIENT_STORE_ERROR";
  return `クライアントストアの読み込みに失敗しました (${code})`;
}

function storeError(code, detail) {
  const e = new Error(`クライアントストアの読み込みに失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail; // マスク済みの詳細。ログ用
  return e;
}

/**
 * 生の設定オブジェクトを正規化する。
 * 欠けているフィールドは既定値で埋め、CMS認証情報を解決する。
 */
function normalize(raw) {
  const cms = raw.cms || {};
  const brand = raw.brand || {};
  const creds = cms.credentials || {};

  return {
    id: raw.id,
    label: raw.label || raw.id,
    enabled: raw.enabled !== false,

    brand: {
      companyName: brand.companyName || "当社",
      serviceName: brand.serviceName || "当社サービス",
      noteUrl: brand.noteUrl || "",
      mediaUrl: brand.mediaUrl || "",
      siteUrl: brand.siteUrl || "",
    },

    cms: {
      type: cms.type || "wordpress",
      baseUrl: (cms.baseUrl || "").replace(/\/+$/, ""),
      defaultPostStatus: cms.defaultPostStatus || "draft",
      // Payload用（Phase 2）。WordPressでは未使用。
      collection: cms.collection || "posts",
      // jsonb の実値（T-01b で管理 API から登録）を優先し、
      // 無ければ従来どおり環境変数名から解決する。既存データは実値を持たないので挙動不変。
      credentials: {
        username: literal(creds.username) || fromEnv(creds.usernameEnv),
        password: literal(creds.password) || fromEnv(creds.passwordEnv),
        apiKey: literal(creds.apiKey) || fromEnv(creds.apiKeyEnv),
      },
      _credentialEnvNames: {
        username: creds.usernameEnv || null,
        password: creds.passwordEnv || null,
        apiKey: creds.apiKeyEnv || null,
      },
      // 管理 API のマスク判定用（実値が jsonb に入っているか）
      _credentialLiterals: {
        username: literal(creds.username),
        password: literal(creds.password),
        apiKey: literal(creds.apiKey),
      },
    },

    spreadsheetId: raw.spreadsheetId || "",
    companyDataFolderId: raw.companyDataFolderId || "",

    // Supabase 移行（T-01）で追加した列。file 経路では未定義なので既定値で埋める。
    isTest: raw.isTest === true,
    siteUrl: raw.siteUrl || null,
    cockpitClientId: raw.cockpitClientId || null,

    // T-02 で追加した列（管理 API が読む）。file 経路では既定値。
    businessType: raw.businessType ?? null,
    targetAreas: toArray(raw.targetAreas),
    ngKeywords: toArray(raw.ngKeywords),
    nonTargetServices: toArray(raw.nonTargetServices),
    clientSensitivities: raw.clientSensitivities ?? "",
    brandTerms: toArray(raw.brandTerms),
    articleUrlPatterns: toArray(raw.articleUrlPatterns),
    ga4PropertyId: raw.ga4PropertyId ?? null,
    gscPropertyUrl: raw.gscPropertyUrl ?? null,
    gscPropertyType: raw.gscPropertyType ?? null,
    ga4RetentionBeforeChange: raw.ga4RetentionBeforeChange ?? null,
    ga4RetentionChangedAt: raw.ga4RetentionChangedAt ?? null,
    gscBqExportEnabledAt: raw.gscBqExportEnabledAt ?? null,
    billingCycleStartDay: raw.billingCycleStartDay ?? null,
    sheetGid: raw.sheetGid ?? null,
    maxPublishPerMonth: raw.maxPublishPerMonth ?? null,
    ngExpressions: raw.ngExpressions ?? null,
    autoApproveThreshold: raw.autoApproveThreshold ?? 0,
    updatedBy: raw.updatedBy ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,

    // jsonb をそのまま保持（管理 API の PATCH で fieldMap 等を落とさずマージするため）
    _raw: { brand, cms },
  };
}

/** Supabase の行（snake_case）を normalize() の入力（camelCase）に変換 */
function fromRow(r) {
  return {
    id: r.id,
    label: r.label,
    enabled: r.enabled,
    brand: r.brand,
    cms: r.cms,
    spreadsheetId: r.spreadsheet_id,
    companyDataFolderId: r.company_data_folder_id,
    isTest: r.is_test,
    siteUrl: r.site_url,
    cockpitClientId: r.cockpit_client_id,
    businessType: r.business_type,
    targetAreas: r.target_areas,
    ngKeywords: r.ng_keywords,
    nonTargetServices: r.non_target_services,
    clientSensitivities: r.client_sensitivities,
    brandTerms: r.brand_terms,
    articleUrlPatterns: r.article_url_patterns,
    ga4PropertyId: r.ga4_property_id,
    gscPropertyUrl: r.gsc_property_url,
    gscPropertyType: r.gsc_property_type,
    ga4RetentionBeforeChange: r.ga4_retention_before_change,
    ga4RetentionChangedAt: r.ga4_retention_changed_at,
    gscBqExportEnabledAt: r.gsc_bq_export_enabled_at,
    billingCycleStartDay: r.billing_cycle_start_day,
    sheetGid: r.sheet_gid,
    maxPublishPerMonth: r.max_publish_per_month,
    ngExpressions: r.ng_expressions,
    autoApproveThreshold: r.auto_approve_threshold,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function loadFromFile() {
  if (!fs.existsSync(CLIENTS_FILE)) {
    throw storeError(
      "CLIENTS_FILE_NOT_FOUND",
      `クライアント設定ファイルが見つかりません: ${CLIENTS_FILE}\n` +
        `clients.example.json をコピーして clients.json を作成してください。`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed.clients || [];
  return list.map(normalize);
}

function supabaseConfig() {
  const url = readSecret("SUPABASE_URL");
  const key = readSecret("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw storeError(
      "SUPABASE_CONFIG_MISSING",
      "CLIENT_STORE=supabase ですが SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です"
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/**
 * PostgREST を呼び、配列の応答を返す。
 * 新形式の Secret key（sb_secret_…）も旧 service_role JWT も、
 * PostgREST は apikey と Authorization: Bearer の両方に同じ値を受け取る。
 * 失敗は code 付き storeError に統一し、キー・URL は必ずマスクする。
 */
async function supabaseRequest(method, pathAndQuery, body) {
  const { url, key } = supabaseConfig();
  const fetch = require("node-fetch");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Prefer = "return=representation";
  }

  let res;
  try {
    res = await fetch(`${url}${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // ネットワーク・ヘッダー不正など。生のメッセージにキーが混ざりうるのでマスクする
    throw storeError("SUPABASE_FETCH_FAILED", maskSecrets(err.message, [key, url]));
  }

  let text = "";
  try {
    text = await res.text();
  } catch (_) {
    /* 本文なし */
  }

  if (!res.ok) {
    // PostgREST のエラー本文: { code, message, details, hint }
    let pg = null;
    try {
      pg = JSON.parse(text);
    } catch (_) {
      /* JSON でない */
    }
    const detail = maskSecrets(text.slice(0, 300), [key, url]);
    if (pg && pg.code === "23505") {
      const e = storeError("SUPABASE_UNIQUE_VIOLATION", detail);
      e.pgCode = pg.code;
      e.constraint = (String(pg.message || "").match(/constraint "([^"]+)"/) || [])[1] || null;
      e.details = maskSecrets(pg.details || "", [key, url]);
      throw e;
    }
    if (pg && pg.code === "23514") {
      const e = storeError("SUPABASE_CHECK_VIOLATION", detail);
      e.pgCode = pg.code;
      e.constraint = (String(pg.message || "").match(/constraint "([^"]+)"/) || [])[1] || null;
      throw e;
    }
    throw storeError(`SUPABASE_HTTP_${res.status}`, detail);
  }

  let rows;
  try {
    rows = text ? JSON.parse(text) : [];
  } catch (err) {
    throw storeError("SUPABASE_BAD_JSON", maskSecrets(err.message, [key, url]));
  }
  if (!Array.isArray(rows)) {
    throw storeError("SUPABASE_BAD_JSON", "配列以外の応答");
  }
  return rows;
}

async function loadFromSupabase() {
  // file 経路と同じく enabled=false も含めて全件返す。
  // 有効判定は getClient() / 各APIが行う（/api/health の件数表示も両経路で揃う）。
  const rows = await supabaseRequest("GET", "/rest/v1/clients?select=*&order=id.asc");
  return rows.map((r) => normalize(fromRow(r)));
}

function invalidateCache() {
  cache = { at: 0, clients: null };
}

/** 書き込みできるのは supabase 経路のみ。file 経路は読み取り専用 */
function isWritable() {
  return STORE_KIND === "supabase";
}

function assertWritable() {
  if (!isWritable()) {
    throw storeError(
      "CLIENT_STORE_READONLY",
      `CLIENT_STORE=${STORE_KIND} は読み取り専用です。書き込みには CLIENT_STORE=supabase が必要です`
    );
  }
}

/**
 * 1 件登録（T-01b）。row は snake_case の列名で渡す。
 * 一意制約違反は SUPABASE_UNIQUE_VIOLATION（constraint 付き）で投げる。
 */
async function createClientRow(row) {
  assertWritable();
  const rows = await supabaseRequest("POST", "/rest/v1/clients", row);
  invalidateCache();
  return normalize(fromRow(rows[0]));
}

/** 1 件更新（T-01b）。patch は snake_case。対象が無ければ CLIENT_NOT_FOUND */
async function updateClientRow(id, patch) {
  assertWritable();
  const rows = await supabaseRequest(
    "PATCH",
    `/rest/v1/clients?id=eq.${encodeURIComponent(id)}`,
    patch
  );
  invalidateCache();
  if (rows.length === 0) {
    throw storeError("CLIENT_NOT_FOUND", `クライアントが見つかりません: ${id}`);
  }
  return normalize(fromRow(rows[0]));
}

/** 全クライアントを取得（短時間キャッシュあり） */
async function listClients({ force = false } = {}) {
  const fresh = Date.now() - cache.at < CACHE_TTL_MS;
  if (!force && cache.clients && fresh) return cache.clients;

  const clients =
    STORE_KIND === "supabase" ? await loadFromSupabase() : await loadFromFile();

  cache = { at: Date.now(), clients };
  return clients;
}

/**
 * clientId からクライアントを取得。
 * 見つからない場合は例外ではなく null を返し、呼び出し側で 400 を返す。
 */
async function getClient(clientId) {
  if (!clientId) return null;
  const clients = await listClients();
  return clients.find((c) => c.id === clientId && c.enabled) || null;
}

/** 管理 API 用。enabled=false（論理削除済み）も返す */
async function findClient(clientId, { force = false } = {}) {
  if (!clientId) return null;
  const clients = await listClients({ force });
  return clients.find((c) => c.id === clientId) || null;
}

/**
 * フロントに返してよい情報だけを抜き出す。
 * 認証情報は「設定済みかどうか」の真偽値のみ露出する。
 */
function toPublic(client) {
  return {
    id: client.id,
    label: client.label,
    brand: client.brand,
    cms: {
      type: client.cms.type,
      baseUrl: client.cms.baseUrl,
      defaultPostStatus: client.cms.defaultPostStatus,
      configured: Boolean(
        client.cms.baseUrl &&
          (client.cms.credentials.apiKey ||
            (client.cms.credentials.username && client.cms.credentials.password))
      ),
    },
    hasSpreadsheet: Boolean(client.spreadsheetId),
    hasCompanyData: Boolean(client.companyDataFolderId),
    isTest: client.isTest,
    siteUrl: client.siteUrl,
    cockpitClientId: client.cockpitClientId,
  };
}

/**
 * 管理 API（/api/admin/clients）向けの応答。全列を返すが、
 * password / apiKey の実値は CREDENTIAL_MASK に置き換える。
 * toPublic() は既存の /api/clients が使うため変更しない。
 */
function toAdmin(client) {
  const rawCms = client._raw?.cms || {};
  const rawBrand = client._raw?.brand || {};
  const lit = client.cms._credentialLiterals || {};
  const env = client.cms._credentialEnvNames || {};
  return {
    id: client.id,
    label: client.label,
    enabled: client.enabled,
    isTest: client.isTest,
    siteUrl: client.siteUrl,
    cockpitClientId: client.cockpitClientId,
    brand: {
      companyName: "",
      serviceName: "",
      noteUrl: "",
      mediaUrl: "",
      siteUrl: "",
      ...rawBrand,
    },
    cms: {
      type: client.cms.type,
      baseUrl: client.cms.baseUrl,
      defaultPostStatus: client.cms.defaultPostStatus,
      collection: rawCms.collection ?? null,
      mediaCollection: rawCms.mediaCollection ?? null,
      authCollection: rawCms.authCollection ?? null,
      fieldMap: rawCms.fieldMap ?? null,
      credentials: {
        username: lit.username || "",
        password: lit.password ? CREDENTIAL_MASK : "",
        apiKey: lit.apiKey ? CREDENTIAL_MASK : "",
        usernameEnv: env.username || "",
        passwordEnv: env.password || "",
        apiKeyEnv: env.apiKey || "",
      },
      configured: Boolean(
        client.cms.baseUrl &&
          (client.cms.credentials.apiKey ||
            (client.cms.credentials.username && client.cms.credentials.password))
      ),
    },
    spreadsheetId: client.spreadsheetId,
    sheetGid: client.sheetGid,
    companyDataFolderId: client.companyDataFolderId,
    businessType: client.businessType,
    targetAreas: client.targetAreas,
    ngKeywords: client.ngKeywords,
    nonTargetServices: client.nonTargetServices,
    clientSensitivities: client.clientSensitivities,
    brandTerms: client.brandTerms,
    articleUrlPatterns: client.articleUrlPatterns,
    ga4PropertyId: client.ga4PropertyId,
    gscPropertyUrl: client.gscPropertyUrl,
    gscPropertyType: client.gscPropertyType,
    ga4RetentionBeforeChange: client.ga4RetentionBeforeChange,
    ga4RetentionChangedAt: client.ga4RetentionChangedAt,
    gscBqExportEnabledAt: client.gscBqExportEnabledAt,
    billingCycleStartDay: client.billingCycleStartDay,
    maxPublishPerMonth: client.maxPublishPerMonth,
    ngExpressions: client.ngExpressions,
    autoApproveThreshold: client.autoApproveThreshold,
    updatedBy: client.updatedBy,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

/** 起動時の健全性チェック。設定漏れを早期に出す。 */
async function validateAll() {
  const clients = await listClients({ force: true });
  const problems = [];
  const seen = new Set();

  for (const c of clients) {
    if (!c.id) problems.push("id のないクライアントがあります");
    if (seen.has(c.id)) problems.push(`clientId が重複しています: ${c.id}`);
    seen.add(c.id);

    if (!c.cms.baseUrl) problems.push(`[${c.id}] cms.baseUrl が未設定`);

    const names = c.cms._credentialEnvNames;
    if (c.cms.type === "wordpress") {
      if (!c.cms.credentials.username)
        problems.push(`[${c.id}] 環境変数 ${names.username || "(未指定)"} が未設定`);
      if (!c.cms.credentials.password)
        problems.push(`[${c.id}] 環境変数 ${names.password || "(未指定)"} が未設定`);
    }
    if (c.cms.type === "payload" && !c.cms.credentials.apiKey) {
      problems.push(`[${c.id}] 環境変数 ${names.apiKey || "(未指定)"} が未設定`);
    }
  }

  return { count: clients.length, problems };
}

module.exports = {
  listClients,
  getClient,
  findClient,
  toPublic,
  toAdmin,
  validateAll,
  describeError,
  // T-01b: 管理 API の書き込み（supabase 経路のみ）
  isWritable,
  createClientRow,
  updateClientRow,
  CREDENTIAL_MASK,
};
