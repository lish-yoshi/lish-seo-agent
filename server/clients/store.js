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
 * 読み取り専用。登録・更新は T-01b で別途実装する。
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
      credentials: {
        username: fromEnv(creds.usernameEnv),
        password: fromEnv(creds.passwordEnv),
        apiKey: fromEnv(creds.apiKeyEnv),
      },
      _credentialEnvNames: {
        username: creds.usernameEnv || null,
        password: creds.passwordEnv || null,
        apiKey: creds.apiKeyEnv || null,
      },
    },

    spreadsheetId: raw.spreadsheetId || "",
    companyDataFolderId: raw.companyDataFolderId || "",

    // Supabase 移行（T-01）で追加した列。file 経路では未定義なので既定値で埋める。
    isTest: raw.isTest === true,
    siteUrl: raw.siteUrl || null,
    cockpitClientId: raw.cockpitClientId || null,
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

async function loadFromSupabase() {
  const url = readSecret("SUPABASE_URL");
  const key = readSecret("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw storeError(
      "SUPABASE_CONFIG_MISSING",
      "CLIENT_STORE=supabase ですが SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です"
    );
  }
  const fetch = require("node-fetch");
  const endpoint = `${url.replace(/\/+$/, "")}/rest/v1/clients?select=*&order=id.asc`;

  // 新形式の Secret key（sb_secret_…）も旧 service_role JWT も、
  // PostgREST は apikey と Authorization: Bearer の両方に同じ値を受け取る。
  let res;
  try {
    // file 経路と同じく enabled=false も含めて全件返す。
    // 有効判定は getClient() / 各APIが行う（/api/health の件数表示も両経路で揃う）。
    res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    // ネットワーク・ヘッダー不正など。生のメッセージにキーが混ざりうるのでマスクする
    throw storeError("SUPABASE_FETCH_FAILED", maskSecrets(err.message, [key, url]));
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch (_) {
      /* 本文なし */
    }
    throw storeError(
      `SUPABASE_HTTP_${res.status}`,
      maskSecrets(body.slice(0, 300), [key, url])
    );
  }
  let rows;
  try {
    rows = await res.json();
  } catch (err) {
    throw storeError("SUPABASE_BAD_JSON", maskSecrets(err.message, [key, url]));
  }
  if (!Array.isArray(rows)) {
    throw storeError("SUPABASE_BAD_JSON", "配列以外の応答");
  }
  return rows.map((r) =>
    normalize({
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
    })
  );
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
  toPublic,
  validateAll,
  describeError,
};
