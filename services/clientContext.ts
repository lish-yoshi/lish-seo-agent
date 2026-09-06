/**
 * クライアント設定のランタイム取得
 *
 * これまで会社名・サービス名・出典URLは VITE_ 環境変数で持っていたが、
 * VITE_ はビルド時にJSへ焼き込まれるため、クライアントごとに別ビルドが必要だった。
 * 起動後にバックエンドから取得する形へ移すことで、1つのデプロイで
 * 全クライアントを扱えるようにする。
 */

export interface ClientBrand {
  companyName: string;
  serviceName: string;
  noteUrl: string;
  mediaUrl: string;
  siteUrl: string;
}

export interface ClientConfig {
  id: string;
  label: string;
  brand: ClientBrand;
  cms: {
    type: "wordpress" | "payload";
    baseUrl: string;
    defaultPostStatus: string;
    configured: boolean;
  };
  hasSpreadsheet: boolean;
  hasCompanyData: boolean;
}

const FALLBACK_BRAND: ClientBrand = {
  companyName: "当社",
  serviceName: "当社サービス",
  noteUrl: "",
  mediaUrl: "",
  siteUrl: "",
};

function backendUrl(): string {
  return (
    import.meta.env.VITE_API_URL?.replace("/api", "") ||
    import.meta.env.VITE_BACKEND_URL ||
    "http://localhost:3001"
  );
}

const STORAGE_KEY = "seo-agent:selected-client";

let activeId: string | null = null;
let activeConfig: ClientConfig | null = null;
const listeners = new Set<(c: ClientConfig | null) => void>();

/** 選択中のクライアントIDを取得（未選択ならlocalStorageから復元） */
export function getActiveClientId(): string | null {
  if (activeId) return activeId;
  try {
    activeId = localStorage.getItem(STORAGE_KEY);
  } catch {
    activeId = null;
  }
  return activeId;
}

/** 利用可能なクライアント一覧を取得 */
export async function fetchClients(): Promise<ClientConfig[]> {
  const res = await fetch(`${backendUrl()}/api/clients`);
  if (!res.ok) throw new Error("クライアント一覧を取得できませんでした");
  const data = await res.json();
  return data.clients ?? [];
}

/**
 * クライアントを切り替える。
 * 設定を読み込み終えるまで記事生成を走らせないこと。
 */
export async function setActiveClient(clientId: string): Promise<ClientConfig> {
  const res = await fetch(
    `${backendUrl()}/api/client-config?clientId=${encodeURIComponent(clientId)}`
  );
  if (!res.ok) {
    throw new Error(`クライアント設定を読み込めませんでした: ${clientId}`);
  }

  const config: ClientConfig = await res.json();
  activeId = clientId;
  activeConfig = config;

  try {
    localStorage.setItem(STORAGE_KEY, clientId);
  } catch {
    // プライベートブラウジング等では保存できないが動作には支障ない
  }

  listeners.forEach((fn) => fn(config));
  return config;
}

/** 読み込み済みの設定を同期的に取得。未読み込みなら null。 */
export function getActiveClient(): ClientConfig | null {
  return activeConfig;
}

/**
 * ブランド情報を同期的に取得する。
 * 未選択でも記事生成が落ちないよう既定値を返す。
 * 旧コードの `import.meta.env.VITE_SERVICE_NAME || '当社サービス'` を
 * `getBrand().serviceName` に置き換える形で移行できる。
 */
export function getBrand(): ClientBrand {
  return activeConfig?.brand ?? FALLBACK_BRAND;
}

/** APIリクエストに付ける共通ヘッダー */
export function clientHeaders(): Record<string, string> {
  const id = getActiveClientId();
  return id ? { "x-client-id": id } : {};
}

/** 設定切り替えの購読（画面側の再描画用） */
export function onClientChange(fn: (c: ClientConfig | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 起動時の復元。App のマウント時に一度呼ぶ。 */
export async function restoreActiveClient(): Promise<ClientConfig | null> {
  const id = getActiveClientId();
  if (!id) return null;
  try {
    return await setActiveClient(id);
  } catch {
    return null;
  }
}
