/**
 * クライアント管理 API（T-01b-1）
 *
 * /api/admin/clients 配下。既存の /api/clients（フロントのクライアント選択用、
 * enabled のみ・toPublic 形）は変更しない。
 *
 * 認可:
 *   - 読み取り: x-api-key（/api 共通の authenticate ミドルウェア）
 *   - 書き込み: x-api-key + requireIapUser（本番は IAP JWT、開発は x-dev-user-email）
 *
 * 削除は物理削除せず enabled=false の論理削除のみ。
 * 有効化は ENABLE_CLIENTS_ADMIN=true（scraping-server.js）。off なら register されない。
 */

const store = require("../clients/store");
const { requireIapUser } = require("../clients/iapUser");

const MASK = store.CREDENTIAL_MASK;

// ---- 入力キー（snake_case → camelCase）。応答は camelCase、DB 列は snake_case ----
const CAMEL_OF = {
  site_url: "siteUrl",
  is_test: "isTest",
  cockpit_client_id: "cockpitClientId",
  spreadsheet_id: "spreadsheetId",
  sheet_gid: "sheetGid",
  company_data_folder_id: "companyDataFolderId",
  business_type: "businessType",
  target_areas: "targetAreas",
  ng_keywords: "ngKeywords",
  non_target_services: "nonTargetServices",
  client_sensitivities: "clientSensitivities",
  brand_terms: "brandTerms",
  article_url_patterns: "articleUrlPatterns",
  ga4_property_id: "ga4PropertyId",
  gsc_property_url: "gscPropertyUrl",
  gsc_property_type: "gscPropertyType",
  ga4_retention_before_change: "ga4RetentionBeforeChange",
  ga4_retention_changed_at: "ga4RetentionChangedAt",
  gsc_bq_export_enabled_at: "gscBqExportEnabledAt",
  billing_cycle_start_day: "billingCycleStartDay",
  max_publish_per_month: "maxPublishPerMonth",
  ng_expressions: "ngExpressions",
  auto_approve_threshold: "autoApproveThreshold",
};
const COLUMN_OF = Object.fromEntries(Object.entries(CAMEL_OF).map(([s, c]) => [c, s]));
for (const k of ["id", "label", "enabled", "brand", "cms"]) COLUMN_OF[k] = k;

// ---- 一意制約 / CHECK 制約 → 対象カラム ----
const UNIQUE_FIELD = {
  clients_pkey: "id",
  clients_site_url_unique_idx: "site_url",
  clients_ga4_property_id_unique_idx: "ga4_property_id",
  clients_gsc_property_url_unique_idx: "gsc_property_url",
  clients_spreadsheet_id_unique_idx: "spreadsheet_id",
  clients_spreadsheet_sheet_unique_idx: "spreadsheet_id, sheet_gid",
};
const CHECK_FIELD = {
  clients_cms_type_check: "cms.type",
  clients_cms_baseurl_check: "cms.baseUrl",
  clients_gsc_property_type_check: "gsc_property_type",
  clients_ga4_retention_before_change_check: "ga4_retention_before_change",
};

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SITE_URL_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CMS_TYPES = ["wordpress", "payload"];
const GSC_TYPES = ["domain", "url_prefix"];
const GA4_RETENTIONS = ["2months", "14months", "unknown"];
const CREDENTIAL_KEYS = ["username", "password", "apiKey", "usernameEnv", "passwordEnv", "apiKeyEnv"];

/** DB の normalize_site_url() と同じ正規化 */
function normalizeSiteUrl(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 入力の snake_case キーを camelCase に寄せる（トップレベルのみ） */
function camelizeInput(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) out[CAMEL_OF[k] || k] = v;
  return out;
}

function str(v, field, { required = false, nullable = true } = {}) {
  if (v === undefined) {
    if (required) throw new ValidationError(field, `${field} は必須です`);
    return undefined;
  }
  if (v === null) {
    if (required || !nullable) throw new ValidationError(field, `${field} は必須です`);
    return null;
  }
  if (typeof v !== "string") throw new ValidationError(field, `${field} は文字列で指定してください`);
  const t = v.trim();
  if (required && t === "") throw new ValidationError(field, `${field} は必須です`);
  return t;
}

function strArray(v, field) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : null;
  if (!arr || !arr.every((x) => typeof x === "string")) {
    throw new ValidationError(field, `${field} は文字列の配列で指定してください`);
  }
  return arr.map((x) => x.trim()).filter((x) => x !== "");
}

function bool(v, field) {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(field, `${field} は true / false で指定してください`);
  return v;
}

function int(v, field, { min, max } = {}) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Number.isInteger(v)) throw new ValidationError(field, `${field} は整数で指定してください`);
  if (min !== undefined && v < min) throw new ValidationError(field, `${field} は ${min} 以上で指定してください`);
  if (max !== undefined && v > max) throw new ValidationError(field, `${field} は ${max} 以下で指定してください`);
  return v;
}

function num(v, field) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(field, `${field} は数値で指定してください`);
  }
  return v;
}

function date(v, field) {
  const s = str(v, field);
  if (s === undefined || s === null) return s;
  if (s === "") return null;
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
    throw new ValidationError(field, `${field} は YYYY-MM-DD 形式で指定してください`);
  }
  return s;
}

function oneOf(v, field, allowed) {
  const s = str(v, field);
  if (s === undefined || s === null) return s;
  if (s === "") return null;
  if (!allowed.includes(s)) {
    throw new ValidationError(field, `${field} は ${allowed.join(" / ")} のいずれかで指定してください`);
  }
  return s;
}

/**
 * brand jsonb。既存値（PATCH 時）にマージする。
 */
function validateBrand(v, existing) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) throw new ValidationError("brand", "brand はオブジェクトで指定してください");
  const merged = { ...(existing || {}) };
  for (const [k, val] of Object.entries(v)) {
    if (val === null) {
      merged[k] = "";
      continue;
    }
    if (typeof val !== "string") throw new ValidationError(`brand.${k}`, `brand.${k} は文字列で指定してください`);
    merged[k] = val.trim();
  }
  return merged;
}

/**
 * cms jsonb。既存値（PATCH 時）にマージする。
 * credentials は CREDENTIAL_MASK / 未指定なら既存値を維持、"" なら消去、それ以外は上書き。
 */
function validateCms(v, existing, { create }) {
  if (v === undefined) {
    if (create) throw new ValidationError("cms", "cms は必須です");
    return undefined;
  }
  if (!isPlainObject(v)) throw new ValidationError("cms", "cms はオブジェクトで指定してください");

  const { credentials: inCreds, ...rest } = v;
  const merged = { ...(existing || {}), ...rest };

  const type = str(merged.type, "cms.type", { required: true });
  if (!CMS_TYPES.includes(type)) {
    throw new ValidationError("cms.type", `cms.type は ${CMS_TYPES.join(" / ")} のいずれかで指定してください`);
  }
  merged.type = type;

  const baseUrl = str(merged.baseUrl, "cms.baseUrl", { required: true });
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    throw new ValidationError("cms.baseUrl", "cms.baseUrl は http(s):// で始まる URL で指定してください");
  }
  merged.baseUrl = baseUrl.replace(/\/+$/, "");

  if (merged.defaultPostStatus !== undefined && merged.defaultPostStatus !== null) {
    merged.defaultPostStatus = str(merged.defaultPostStatus, "cms.defaultPostStatus") || "draft";
  }
  if (merged.fieldMap !== undefined && merged.fieldMap !== null && !isPlainObject(merged.fieldMap)) {
    throw new ValidationError("cms.fieldMap", "cms.fieldMap はオブジェクトで指定してください");
  }

  const creds = { ...((existing && existing.credentials) || {}) };
  if (inCreds !== undefined) {
    if (!isPlainObject(inCreds)) {
      throw new ValidationError("cms.credentials", "cms.credentials はオブジェクトで指定してください");
    }
    for (const [k, val] of Object.entries(inCreds)) {
      if (!CREDENTIAL_KEYS.includes(k)) {
        throw new ValidationError(`cms.credentials.${k}`, `cms.credentials.${k} は未対応の項目です`);
      }
      if (val === undefined || val === MASK) continue; // 既存値を維持
      if (val === null || val === "") {
        delete creds[k];
        continue;
      }
      if (typeof val !== "string") {
        throw new ValidationError(`cms.credentials.${k}`, `cms.credentials.${k} は文字列で指定してください`);
      }
      if (/Env$/.test(k) && !/^[A-Z][A-Z0-9_]*$/.test(val)) {
        throw new ValidationError(`cms.credentials.${k}`, `cms.credentials.${k} は環境変数名（大文字・数字・_）で指定してください`);
      }
      creds[k] = val;
    }
  }
  merged.credentials = creds;
  return merged;
}

/**
 * 入力を検証し、camelCase の値オブジェクトを返す。
 * create=true なら id / label / siteUrl / cms を必須にする。
 * existing は PATCH 時の現在値（brand / cms のマージ元）。
 */
function validateInput(body, { create, existing } = {}) {
  if (!isPlainObject(body)) throw new ValidationError(null, "リクエスト本文は JSON オブジェクトで指定してください");
  const input = camelizeInput(body);
  const out = {};

  if (create) {
    const id = str(input.id, "id", { required: true });
    if (!ID_RE.test(id) || id.length < 3 || id.length > 40) {
      throw new ValidationError("id", "id は小文字英数字とハイフン（例: english-with）で 3〜40 文字にしてください");
    }
    out.id = id;
  } else if (input.id !== undefined && input.id !== existing.id) {
    throw new ValidationError("id", "id は変更できません");
  }

  const label = str(input.label, "label", { required: create, nullable: false });
  if (label !== undefined) out.label = label;

  const siteUrl = str(input.siteUrl, "site_url", { required: create });
  if (siteUrl !== undefined) {
    const n = siteUrl === null ? null : normalizeSiteUrl(siteUrl);
    if (n !== null && n !== "" && !SITE_URL_RE.test(n)) {
      throw new ValidationError("site_url", "site_url はドメイン形式（例: example.com）で指定してください");
    }
    out.siteUrl = n === "" ? null : n;
  }

  const brand = validateBrand(input.brand, existing?._raw?.brand);
  if (brand !== undefined) out.brand = brand;
  const cms = validateCms(input.cms, existing?._raw?.cms, { create });
  if (cms !== undefined) out.cms = cms;

  const enabled = bool(input.enabled, "enabled");
  if (enabled !== undefined) out.enabled = enabled;
  const isTest = bool(input.isTest, "is_test");
  if (isTest !== undefined) out.isTest = isTest;

  for (const [k, f] of [
    ["cockpitClientId", "cockpit_client_id"],
    ["spreadsheetId", "spreadsheet_id"],
    ["sheetGid", "sheet_gid"],
    ["companyDataFolderId", "company_data_folder_id"],
    ["businessType", "business_type"],
    ["clientSensitivities", "client_sensitivities"],
    ["ga4PropertyId", "ga4_property_id"],
    ["gscPropertyUrl", "gsc_property_url"],
  ]) {
    const v = str(input[k], f);
    if (v !== undefined) out[k] = v;
  }
  // spreadsheet_id / company_data_folder_id は既存の既定が '' なので NULL は '' に寄せる
  if (out.spreadsheetId === null) out.spreadsheetId = "";
  if (out.companyDataFolderId === null) out.companyDataFolderId = "";

  for (const [k, f] of [
    ["targetAreas", "target_areas"],
    ["ngKeywords", "ng_keywords"],
    ["nonTargetServices", "non_target_services"],
    ["brandTerms", "brand_terms"],
    ["articleUrlPatterns", "article_url_patterns"],
  ]) {
    const v = strArray(input[k], f);
    if (v !== undefined) out[k] = v;
  }

  const gscType = oneOf(input.gscPropertyType, "gsc_property_type", GSC_TYPES);
  if (gscType !== undefined) out.gscPropertyType = gscType;
  const retention = oneOf(input.ga4RetentionBeforeChange, "ga4_retention_before_change", GA4_RETENTIONS);
  if (retention !== undefined) out.ga4RetentionBeforeChange = retention;

  const d1 = date(input.ga4RetentionChangedAt, "ga4_retention_changed_at");
  if (d1 !== undefined) out.ga4RetentionChangedAt = d1;
  const d2 = date(input.gscBqExportEnabledAt, "gsc_bq_export_enabled_at");
  if (d2 !== undefined) out.gscBqExportEnabledAt = d2;

  const bill = int(input.billingCycleStartDay, "billing_cycle_start_day", { min: 1, max: 31 });
  if (bill !== undefined) out.billingCycleStartDay = bill;
  const maxPub = int(input.maxPublishPerMonth, "max_publish_per_month", { min: 0 });
  if (maxPub !== undefined) out.maxPublishPerMonth = maxPub;
  const thr = num(input.autoApproveThreshold, "auto_approve_threshold");
  if (thr !== undefined) out.autoApproveThreshold = thr;

  if (input.ngExpressions !== undefined) {
    const v = input.ngExpressions;
    if (v !== null && !isPlainObject(v) && !Array.isArray(v)) {
      throw new ValidationError("ng_expressions", "ng_expressions は JSON オブジェクトまたは配列で指定してください");
    }
    out.ngExpressions = v;
  }

  return out;
}

/** camelCase の値 → DB 行（snake_case） */
function toRow(values, updatedBy) {
  const row = {};
  for (const [k, v] of Object.entries(values)) {
    const col = COLUMN_OF[k];
    if (!col) continue;
    row[col] = v;
  }
  row.updated_by = updatedBy;
  return row;
}

/** 類似ドメイン（サブドメイン違い）の既存登録があれば警告文を返す */
async function similarDomainWarnings(siteUrl, selfId) {
  if (!siteUrl) return [];
  const clients = await store.listClients();
  const warnings = [];
  for (const c of clients) {
    if (c.id === selfId || !c.siteUrl || c.siteUrl === siteUrl) continue;
    if (c.siteUrl.endsWith("." + siteUrl) || siteUrl.endsWith("." + c.siteUrl)) {
      warnings.push(`類似ドメインの登録があります: ${c.id}（${c.siteUrl}）`);
    }
  }
  return warnings;
}

/** ストア由来のエラーを HTTP に変換 */
function sendStoreError(res, err, label) {
  const code = err.code || "CLIENT_STORE_ERROR";
  if (code === "SUPABASE_UNIQUE_VIOLATION") {
    const field =
      UNIQUE_FIELD[err.constraint] ||
      (String(err.details || "").match(/Key \(([^)]+)\)=/) || [])[1] ||
      null;
    return res.status(409).json({ error: "既に登録されています", field, constraint: err.constraint });
  }
  if (code === "SUPABASE_CHECK_VIOLATION") {
    return res.status(400).json({
      error: "値が許可されていません",
      field: CHECK_FIELD[err.constraint] || null,
      constraint: err.constraint,
    });
  }
  if (code === "CLIENT_NOT_FOUND") return res.status(404).json({ error: err.message, code });
  if (code === "CLIENT_STORE_READONLY") {
    return res.status(501).json({ error: "このサーバーのクライアントストアは読み取り専用です", code });
  }
  console.error(`❌ ${label}: ${store.describeError(err)}` + (err.detail ? ` | ${err.detail}` : ""));
  return res.status(500).json({ error: store.describeError(err), code });
}

function sendValidationError(res, err) {
  return res.status(400).json({ error: err.message, field: err.field });
}

function audit(event, req, extra) {
  console.log(
    JSON.stringify({
      event,
      user: req.iapUser?.email ?? null,
      source: req.iapUser?.source ?? null,
      ...extra,
      timestamp: new Date().toISOString(),
    })
  );
}

function register(app) {
  // ---- 認証確認 ----
  app.get("/api/admin/whoami", requireIapUser, (req, res) => {
    res.json({ email: req.iapUser.email, source: req.iapUser.source });
  });

  // ---- 一覧（既定は enabled=false も含む全件） ----
  app.get("/api/admin/clients", async (req, res) => {
    try {
      let clients = await store.listClients();
      if (req.query.include_disabled === "0" || req.query.include_disabled === "false") {
        clients = clients.filter((c) => c.enabled);
      }
      res.json({ clients: clients.map(store.toAdmin), writable: store.isWritable() });
    } catch (err) {
      sendStoreError(res, err, "クライアント一覧（管理）の取得");
    }
  });

  // ---- 1 件（論理削除済みも返す） ----
  app.get("/api/admin/clients/:id", async (req, res) => {
    try {
      const client = await store.findClient(req.params.id);
      if (!client) {
        return res.status(404).json({ error: `クライアントが見つかりません: ${req.params.id}` });
      }
      res.json(store.toAdmin(client));
    } catch (err) {
      sendStoreError(res, err, "クライアント（管理）の取得");
    }
  });

  // ---- 登録 ----
  app.post("/api/admin/clients", requireIapUser, async (req, res) => {
    let values;
    try {
      values = validateInput(req.body, { create: true });
    } catch (err) {
      if (err instanceof ValidationError) return sendValidationError(res, err);
      throw err;
    }
    try {
      const warnings = await similarDomainWarnings(values.siteUrl, values.id);
      const created = await store.createClientRow(toRow(values, req.iapUser.email));
      audit("client_created", req, { clientId: created.id, siteUrl: created.siteUrl });
      res.status(201).json({ client: store.toAdmin(created), warnings });
    } catch (err) {
      sendStoreError(res, err, "クライアント登録");
    }
  });

  // ---- 更新（部分） ----
  app.patch("/api/admin/clients/:id", requireIapUser, async (req, res) => {
    let existing;
    try {
      existing = await store.findClient(req.params.id, { force: true });
    } catch (err) {
      return sendStoreError(res, err, "クライアント更新");
    }
    if (!existing) {
      return res.status(404).json({ error: `クライアントが見つかりません: ${req.params.id}` });
    }
    let values;
    try {
      values = validateInput(req.body, { create: false, existing });
    } catch (err) {
      if (err instanceof ValidationError) return sendValidationError(res, err);
      throw err;
    }
    if (Object.keys(values).length === 0) {
      return res.status(400).json({ error: "更新する項目がありません", field: null });
    }
    try {
      const warnings =
        values.siteUrl !== undefined ? await similarDomainWarnings(values.siteUrl, existing.id) : [];
      const updated = await store.updateClientRow(existing.id, toRow(values, req.iapUser.email));
      audit("client_updated", req, { clientId: updated.id, fields: Object.keys(values) });
      res.json({ client: store.toAdmin(updated), warnings });
    } catch (err) {
      sendStoreError(res, err, "クライアント更新");
    }
  });

  // ---- 論理削除 ----
  app.delete("/api/admin/clients/:id", requireIapUser, async (req, res) => {
    try {
      const existing = await store.findClient(req.params.id, { force: true });
      if (!existing) {
        return res.status(404).json({ error: `クライアントが見つかりません: ${req.params.id}` });
      }
      const updated = await store.updateClientRow(existing.id, {
        enabled: false,
        updated_by: req.iapUser.email,
      });
      audit("client_disabled", req, { clientId: updated.id });
      res.json({ id: updated.id, enabled: updated.enabled });
    } catch (err) {
      sendStoreError(res, err, "クライアント無効化");
    }
  });
}

module.exports = { register, validateInput, normalizeSiteUrl, ValidationError };
