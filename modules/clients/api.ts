/**
 * クライアント管理 API（/api/admin/*）の呼び出し（T-01b-2）
 *
 * 管理画面からの /api 呼び出しはすべてここを通す。
 * URL とヘッダーは services/clientContext の backendUrl() / clientHeaders() を再利用する。
 * 400 / 409 の { error, field } は ApiError に載せ、フォーム側で該当項目に表示する。
 */

import { backendUrl, clientHeaders } from "../../services/clientContext";

export interface AdminCredentials {
  username: string;
  password: string; // 設定済みなら "••••••••"、未設定なら ""
  apiKey: string;
  usernameEnv: string;
  passwordEnv: string;
  apiKeyEnv: string;
}

export interface AdminClient {
  id: string;
  label: string;
  enabled: boolean;
  isTest: boolean;
  siteUrl: string | null;
  cockpitClientId: string | null;
  brand: {
    companyName: string;
    serviceName: string;
    noteUrl: string;
    mediaUrl: string;
    siteUrl: string;
  };
  cms: {
    type: "wordpress" | "payload";
    baseUrl: string;
    defaultPostStatus: string;
    collection: string | null;
    mediaCollection: string | null;
    authCollection: string | null;
    fieldMap: Record<string, string> | null;
    credentials: AdminCredentials;
    configured: boolean;
  };
  spreadsheetId: string;
  sheetGid: string | null;
  companyDataFolderId: string;
  businessType: string | null;
  targetAreas: string[];
  ngKeywords: string[];
  nonTargetServices: string[];
  clientSensitivities: string;
  brandTerms: string[];
  articleUrlPatterns: string[];
  ga4PropertyId: string | null;
  gscPropertyUrl: string | null;
  gscPropertyType: "domain" | "url_prefix" | null;
  ga4RetentionBeforeChange: "2months" | "14months" | "unknown" | null;
  ga4RetentionChangedAt: string | null;
  gscBqExportEnabledAt: string | null;
  billingCycleStartDay: number | null;
  maxPublishPerMonth: number | null;
  ngExpressions: unknown;
  autoApproveThreshold: number;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** POST / PATCH の本文。camelCase。cms は部分指定可（サーバーがマージする） */
export type AdminClientInput = Partial<{
  id: string;
  label: string;
  siteUrl: string | null;
  enabled: boolean;
  isTest: boolean;
  brand: Partial<AdminClient["brand"]>;
  cms: Partial<{
    type: "wordpress" | "payload";
    baseUrl: string;
    defaultPostStatus: string;
    credentials: Partial<AdminCredentials>;
  }>;
  spreadsheetId: string | null;
  sheetGid: string | null;
  companyDataFolderId: string | null;
  businessType: string | null;
  targetAreas: string[];
  ngKeywords: string[];
  nonTargetServices: string[];
  clientSensitivities: string | null;
  brandTerms: string[];
  articleUrlPatterns: string[];
  ga4PropertyId: string | null;
  gscPropertyUrl: string | null;
  gscPropertyType: string | null;
  ga4RetentionBeforeChange: string | null;
  ga4RetentionChangedAt: string | null;
  gscBqExportEnabledAt: string | null;
  billingCycleStartDay: number | null;
  maxPublishPerMonth: number | null;
}>;

export const CREDENTIAL_MASK = "••••••••";

/** API のエラー応答。field は API の表記（snake_case / "cms.type" 等）のまま持つ */
export class ApiError extends Error {
  status: number;
  field: string | null;
  constraint: string | null;
  code: string | null;
  constructor(status: number, message: string, field: string | null = null, extra: { constraint?: string | null; code?: string | null } = {}) {
    super(message);
    this.status = status;
    this.field = field;
    this.constraint = extra.constraint ?? null;
    this.code = extra.code ?? null;
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...clientHeaders() };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${backendUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, `サーバーに接続できません: ${(err as Error).message}`);
  }

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const message =
      (data && typeof data.error === "string" && data.error) ||
      (res.status === 401 ? "IAP 認証が必要です" : res.status === 404 ? "見つかりません" : `エラー (${res.status})`);
    throw new ApiError(res.status, message, data?.field ?? null, {
      constraint: data?.constraint ?? null,
      code: data?.code ?? null,
    });
  }
  return data as T;
}

export async function whoami(): Promise<{ email: string; source: "iap" | "dev" }> {
  return request("GET", "/api/admin/whoami");
}

export async function listAdminClients(): Promise<{ clients: AdminClient[]; writable: boolean }> {
  return request("GET", "/api/admin/clients");
}

export async function getAdminClient(id: string): Promise<AdminClient> {
  return request("GET", `/api/admin/clients/${encodeURIComponent(id)}`);
}

export async function createAdminClient(
  input: AdminClientInput
): Promise<{ client: AdminClient; warnings: string[] }> {
  return request("POST", "/api/admin/clients", input);
}

export async function updateAdminClient(
  id: string,
  patch: AdminClientInput
): Promise<{ client: AdminClient; warnings: string[] }> {
  return request("PATCH", `/api/admin/clients/${encodeURIComponent(id)}`, patch);
}

export async function disableAdminClient(id: string): Promise<{ id: string; enabled: boolean }> {
  return request("DELETE", `/api/admin/clients/${encodeURIComponent(id)}`);
}
